// Rayyy.ai phone client — voice loop.
//
// Flow:
//   Tap to start  -> getUserMedia({audio}) + unlock AudioContext + load /health
//   Talk          -> open WS to Worker /ws, stream mic PCM16 @ 16kHz
//                    receive audio frames, decode base64 PCM16, schedule via
//                    AudioBufferSourceNodes on a MediaStreamDestination ->
//                    <audio> sink. Web Audio handles 24kHz -> device-rate.
//
// Hard rules baked in here (each one is a real bug we already paid for):
//   - speechConfig is set server-side. Client never touches it.
//   - Output goes through MediaStreamDestination -> <audio>, NOT direct to
//     outCtx.destination. Direct path loses the loudspeaker on iOS Safari
//     when the camera turns on (audio flips to the earpiece speaker).
//   - Mic ScriptProcessor sinks to a muted GainNode, NOT inCtx.destination —
//     two AudioContexts both feeding speakers fight iOS's resampler.
//   - Flush queued audio sources on serverContent.interrupted (barge-in),
//     otherwise overlapping turns sound like pitch wobble.
//   - audioOut.playbackRate = 1.0 + preservesPitch = true so iOS media
//     policy nudges don't drift the rate.
//   - Reset nextStartTime = outCtx.currentTime on AudioContext resume.
//   - Block stacked sessions: ignore Talk while ws.readyState === CONNECTING.

// ---------- config ----------
const RELAY_BASE = inferRelayBase();
const WS_URL = RELAY_BASE.replace(/^http/, "ws") + "/ws";

const INPUT_SAMPLE_RATE = 16000; // Gemini Live wants 16kHz mono PCM16 in
const OUTPUT_SAMPLE_RATE = 24000; // Gemini Live emits 24kHz mono PCM16 out
// Jitter buffer: each turn's first audio chunk is scheduled this far in the
// future. Subsequent chunks ride the queue. The cushion absorbs network jitter
// and TTS rate variation — without it, late chunks underrun and you hear
// sputtering / pitch wobble. 700ms is a clear "Rayyy is thinking" pause that
// feels intentional and lets the queue fill comfortably before playback.
const SCHEDULE_LOOKAHEAD_S = 0.7;

// ---------- DOM ----------
const startBtn = document.getElementById("start-btn");
const talkBtn = document.getElementById("talk-btn");
const statusEl = document.getElementById("status");
const voiceTag = document.getElementById("voice-tag");
const audioOut = document.getElementById("audio-out");
const viewfinderCard = document.getElementById("viewfinder-card");
const viewfinderCanvas = document.getElementById("viewfinder");
const viewfinderCaption = document.getElementById("viewfinder-caption");

// ---------- state ----------
let micStream = null;
let inCtx = null;
let outCtx = null;
let outDest = null; // MediaStreamDestination — fed into the <audio> element for iOS-safe loudspeaker routing
let micProcessor = null;
let micSource = null;
let micSink = null; // GainNode at 0 — keeps ScriptProcessor pumping without feeding speakers
let ws = null;
let isTalking = false;
let nextStartTime = 0;
let activeSources = []; // BufferSourceNodes currently scheduled — flushed on barge-in

// Phase 7 — voice provider state.
// "gemini": Gemini Live native audio (Aoede). audio modality from the model.
// "elevenlabs": Gemini returns TEXT, phone POSTs to /tts/elevenlabs for MP3 playback.
let currentProvider = "gemini";
let pendingProviderSwitch = null; // queued switch — performed after current turn audio drains
let pendingTextThisTurn = ""; // accumulated text chunks in elevenlabs mode (per turn)
let elevenlabsAudioUrl = null; // current blob URL for cleanup

// camera state
let camStream = null;
let camVideo = null; // off-DOM <video>, painted to canvas via rAF
let camRafId = 0;
let camFrameTimer = 0; // setInterval id for periodic 1fps frame send
let camAutoOffTimer = 0; // 15s backstop
let camActive = false;
const CAM_AUTO_OFF_MS = 15000;
const CAM_FRAME_INTERVAL_MS = 1000; // 1 fps to Gemini while looking
// Longer than it feels, but worth it: most "first attempt was wrong" reports
// come from camera firing a frame before autofocus locks. Bumping from 800
// to 1200 buys the lens enough time to converge.
const CAM_AUTOFOCUS_PAUSE_MS = 1200;
// Number of priming frames + spacing between them, sent INSIDE the
// enable_camera tool handler before the response returns. The model receives
// several timestamped views of the scene instead of betting on a single one.
const CAM_PRIMING_FRAMES = 3;
const CAM_PRIMING_INTERVAL_MS = 300;

// ---------- helpers ----------
function inferRelayBase() {
  // Allow override via ?relay=https://host
  const params = new URLSearchParams(location.search);
  const override = params.get("relay");
  if (override) return override.replace(/\/$/, "");
  // Default to deployed Worker subdomain (matches CLAUDE.md final state).
  return "https://rayyy-relay.fred-53e.workers.dev";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function updateVoiceTag(health) {
  if (!health) return;
  if (currentProvider === "elevenlabs") {
    const voice = health.providers?.elevenlabs?.voice_id?.slice(0, 6) || "ElevenLabs";
    voiceTag.textContent = `Voice: ElevenLabs · ${health.providers?.elevenlabs?.model_id || ""}`;
  } else {
    voiceTag.textContent = `Voice: ${health.voice} · ${health.model}`;
  }
}

function isConnecting() {
  return ws && ws.readyState === WebSocket.CONNECTING;
}
function isOpen() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function teardownWs(reason = "client teardown") {
  if (ws) {
    try {
      ws.close(1000, reason);
    } catch (_) {}
    ws = null;
  }
}

function stopMicCapture() {
  try {
    if (micProcessor) micProcessor.disconnect();
  } catch (_) {}
  try {
    if (micSource) micSource.disconnect();
  } catch (_) {}
  micProcessor = null;
  micSource = null;
}

// ---------- audio: output sink ----------
// Judges may pick up the phone WITHOUT earbuds. iOS Safari flips audio output
// to the tiny earpiece speaker the moment getUserMedia({video}) runs (camera
// active). The fix: route AudioContext through MediaStreamDestination -> <audio>,
// which uses iOS's media-playback path and preserves loudspeaker routing across
// audio session changes.
//
// This pipeline adds a buffer, which can cause pitch wobble if pre-interrupt
// audio overlaps with the next reply. The barge-in flush below (flushAudio()
// on serverContent.interrupted) is what keeps it steady.
function ensureOutputContext() {
  if (outCtx && outCtx.state !== "closed") return outCtx;
  outCtx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "playback",
  });
  outDest = outCtx.createMediaStreamDestination();
  audioOut.srcObject = outDest.stream;
  audioOut.volume = 1.0;
  // Reset queue clock on resume so we don't schedule in the past.
  outCtx.addEventListener("statechange", () => {
    if (outCtx.state === "running") {
      nextStartTime = outCtx.currentTime;
    }
  });
  return outCtx;
}

async function unlockAudio() {
  ensureOutputContext();
  try {
    if (outCtx.state === "suspended") await outCtx.resume();
  } catch (_) {}
  // Lock natural rate — iOS media policy can otherwise drift this.
  try {
    audioOut.playbackRate = 1.0;
    audioOut.preservesPitch = true;
  } catch (_) {}
  // Force the <audio> sink to start so iOS commits to media-playback routing.
  try {
    await audioOut.play();
  } catch (_) {}
  nextStartTime = outCtx.currentTime;
}

// Barge-in flush: stop every scheduled audio source NOW and reset the queue clock.
// Without this, when the user starts talking, the model's pre-interrupt audio
// keeps playing in parallel with the next reply -> overlapping voices.
function flushAudio(_reason = "interrupt") {
  for (const node of activeSources) {
    try {
      node.onended = null;
      node.stop(0);
      node.disconnect();
    } catch (_) {}
  }
  activeSources = [];
  if (outCtx) nextStartTime = outCtx.currentTime + SCHEDULE_LOOKAHEAD_S;
  // Also stop any in-flight ElevenLabs MP3 playback.
  try {
    audioOut.pause();
    audioOut.removeAttribute("src");
    audioOut.load();
  } catch (_) {}
  if (elevenlabsAudioUrl) {
    URL.revokeObjectURL(elevenlabsAudioUrl);
    elevenlabsAudioUrl = null;
  }
  // Restore the AudioContext stream binding for the gemini path.
  if (outDest) audioOut.srcObject = outDest.stream;
}

// Wait until the current audio output has fully drained. For gemini provider
// that means activeSources is empty; for elevenlabs it means audioOut paused.
function waitForAudioToDrain(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = performance.now();
    (function tick() {
      const drained =
        activeSources.length === 0 &&
        (audioOut.paused || audioOut.ended || !audioOut.src);
      if (drained) return resolve(true);
      if (performance.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 120);
    })();
  });
}

// Switch voice provider mid-conversation. Tears down the current WS,
// flips currentProvider, and reopens with the new modality.
async function switchProvider(provider) {
  currentProvider = provider;
  // Reset audio routing depending on provider.
  if (provider === "elevenlabs") {
    // Detach the AudioContext stream so we can play MP3 blob URLs directly.
    audioOut.srcObject = null;
  } else {
    if (outDest) audioOut.srcObject = outDest.stream;
  }
  setStatus(`Switching to ${provider}…`);
  teardownWs("provider switch");
  // Refresh the on-screen voice tag so the user can see the change.
  try {
    const r = await fetch(RELAY_BASE + "/health", { cache: "no-store" });
    if (r.ok) updateVoiceTag(await r.json());
  } catch (_) {}
  // Small gap, then reopen.
  await new Promise((r) => setTimeout(r, 250));
  openSession();
}

// ElevenLabs path: POST the full per-turn text to /tts/elevenlabs, get back
// a streaming MP3, play via the <audio> element.
async function synthesizeWithElevenLabs(text) {
  setStatus("Rayyy is thinking…");
  try {
    const r = await fetch(RELAY_BASE + "/tts/elevenlabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      setStatus("ElevenLabs error: " + r.status);
      return;
    }
    const blob = await r.blob();
    if (elevenlabsAudioUrl) URL.revokeObjectURL(elevenlabsAudioUrl);
    elevenlabsAudioUrl = URL.createObjectURL(blob);
    audioOut.srcObject = null;
    audioOut.src = elevenlabsAudioUrl;
    audioOut.playbackRate = 1.0;
    try {
      await audioOut.play();
    } catch (_) {}
    setStatus("Rayyy is speaking…");
    audioOut.onended = () => {
      if (isOpen()) setStatus("Listening…");
    };
  } catch (err) {
    setStatus("ElevenLabs error: " + (err && err.message));
  }
}

// Decode base64 PCM16, create AudioBuffer at the SOURCE rate (e.g. 24kHz),
// connect to MediaStreamDestination -> <audio>, schedule. Web Audio handles
// the rate conversion to outCtx.sampleRate at playback time.
function playAudioChunk(base64Pcm, sourceRate) {
  if (!outCtx || !outDest) return;
  const bytes = base64ToBytes(base64Pcm);
  if (bytes.length < 2) return;

  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const float = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) float[i] = samples[i] / 32768;

  const rate = sourceRate || OUTPUT_SAMPLE_RATE;
  const buffer = outCtx.createBuffer(1, float.length, rate);
  buffer.copyToChannel(float, 0);

  const node = outCtx.createBufferSource();
  node.buffer = buffer;
  node.connect(outDest);

  const now = outCtx.currentTime;
  const minSchedule = now + SCHEDULE_LOOKAHEAD_S;
  if (nextStartTime < minSchedule) nextStartTime = minSchedule;
  activeSources.push(node);
  node.onended = () => {
    const i = activeSources.indexOf(node);
    if (i >= 0) activeSources.splice(i, 1);
  };
  node.start(nextStartTime);
  nextStartTime += buffer.duration;
}

function parseRateFromMime(mime) {
  if (!mime) return null;
  const m = mime.match(/rate=(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Mic-side resample for outgoing PCM16 (Gemini Live wants 16kHz).
// Output side no longer JS-resamples — Web Audio handles 24k -> device rate.
function linearResample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

// ---------- audio: mic capture ----------
async function startMicCapture() {
  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  }
  if (!inCtx || inCtx.state === "closed") {
    inCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: INPUT_SAMPLE_RATE,
    });
  }
  if (inCtx.state === "suspended") await inCtx.resume();

  micSource = inCtx.createMediaStreamSource(micStream);
  // ScriptProcessor is deprecated but uniformly available on iOS Safari.
  // Audio worklets work too but add complexity for Phase 2.
  micProcessor = inCtx.createScriptProcessor(2048, 1, 1);
  const realRate = inCtx.sampleRate; // iOS may ignore the requested 16k

  micProcessor.onaudioprocess = (e) => {
    if (!isOpen()) return;
    const float = e.inputBuffer.getChannelData(0);
    const resampled =
      realRate === INPUT_SAMPLE_RATE
        ? float
        : linearResample(float, realRate, INPUT_SAMPLE_RATE);
    const pcm16 = floatToPcm16(resampled);
    const base64 = bytesToBase64(new Uint8Array(pcm16.buffer));
    // Gemini Live deprecated realtimeInput.mediaChunks — use the typed
    // {audio,video,text} fields directly.
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: base64 },
        },
      })
    );
  };

  micSource.connect(micProcessor);
  // ScriptProcessor needs SOMETHING downstream for onaudioprocess to fire,
  // but we don't actually want mic going to speakers — that creates a second
  // AudioContext output competing with outCtx, and on iOS the OS resampler
  // wobbles when both are active. Sink to a muted gain instead.
  if (!micSink || micSink.context !== inCtx) {
    micSink = inCtx.createGain();
    micSink.gain.value = 0;
    micSink.connect(inCtx.destination);
  }
  micProcessor.connect(micSink);
}

function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// ---------- camera (voice-activated) ----------
// The off-DOM <video> + visible <canvas> pattern is deliberate:
// an in-DOM <video> element interferes with iOS audio routing even when muted.
// Painting the video to a canvas via rAF reduces (does not eliminate) that.
async function startCamera() {
  if (camActive) return;
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 640 } },
    audio: false,
  });

  camVideo = document.createElement("video");
  camVideo.muted = true;
  camVideo.playsInline = true;
  camVideo.autoplay = true;
  camVideo.srcObject = camStream;
  // Deliberately NOT appended to the DOM.
  await camVideo.play().catch(() => {});

  // Wait for video to actually have dimensions.
  await waitFor(() => camVideo.videoWidth > 0 && camVideo.videoHeight > 0, 3000);

  viewfinderCard.classList.remove("hidden");
  viewfinderCaption.textContent = "Rayyy is looking…";

  // Paint loop.
  const ctx = viewfinderCanvas.getContext("2d");
  const draw = () => {
    if (!camActive || !camVideo) return;
    try {
      ctx.drawImage(camVideo, 0, 0, viewfinderCanvas.width, viewfinderCanvas.height);
    } catch (_) {}
    camRafId = requestAnimationFrame(draw);
  };
  camActive = true;
  camRafId = requestAnimationFrame(draw);

  // Periodic 1fps frame send to Gemini.
  camFrameTimer = setInterval(() => sendCameraFrame(), CAM_FRAME_INTERVAL_MS);

  // 15s backstop. Reset on each frame send via resetAutoOff().
  resetAutoOff();
}

function stopCamera() {
  if (!camActive) return;
  camActive = false;
  if (camRafId) cancelAnimationFrame(camRafId);
  if (camFrameTimer) clearInterval(camFrameTimer);
  if (camAutoOffTimer) clearTimeout(camAutoOffTimer);
  camRafId = 0;
  camFrameTimer = 0;
  camAutoOffTimer = 0;
  if (camStream) {
    for (const track of camStream.getTracks()) {
      try {
        track.stop();
      } catch (_) {}
    }
  }
  camStream = null;
  camVideo = null;
  viewfinderCard.classList.add("hidden");
}

function resetAutoOff() {
  if (camAutoOffTimer) clearTimeout(camAutoOffTimer);
  camAutoOffTimer = setTimeout(() => {
    if (camActive) stopCamera();
  }, CAM_AUTO_OFF_MS);
}

// Capture a JPEG from the canvas and send to Gemini Live.
function sendCameraFrame() {
  if (!camActive || !isOpen()) return;
  let dataUrl;
  try {
    dataUrl = viewfinderCanvas.toDataURL("image/jpeg", 0.7);
  } catch (_) {
    return;
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return;
  const base64 = dataUrl.slice(comma + 1);
  ws.send(
    JSON.stringify({
      realtimeInput: {
        video: { mimeType: "image/jpeg", data: base64 },
      },
    })
  );
  resetAutoOff();
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    (function tick() {
      if (predicate()) return resolve(true);
      if (performance.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    })();
  });
}

// ---------- tool dispatch ----------
// Gemini Live sends:  { toolCall: { functionCalls: [{ name, args, id }] } }
// We respond with:    { toolResponse: { functionResponses: [{ id, name, response: { result: ... } }] } }
//
// The critical contract for enable_camera: AWAIT the first real frame send
// before returning. Otherwise the model generates a vision answer before it
// has seen anything, and you get hallucinations on the first turn.
async function handleToolCall(toolCall) {
  const calls = toolCall?.functionCalls || [];
  for (const call of calls) {
    let result;
    try {
      result = await dispatchTool(call.name, call.args || {});
    } catch (err) {
      result = { ok: false, error: String(err && err.message) || "tool error" };
    }
    if (!isOpen()) return;
    ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            { id: call.id, name: call.name, response: { result } },
          ],
        },
      })
    );
  }
}

async function dispatchTool(name, _args) {
  switch (name) {
    case "enable_camera": {
      if (!camActive) {
        await startCamera();
      }
      // Autofocus / aim-time pause so the first frame isn't garbage.
      await new Promise((r) => setTimeout(r, CAM_AUTOFOCUS_PAUSE_MS));
      // Ship multiple priming frames spaced apart so the model has more than
      // one timestamped view of the scene before it answers. Single-frame
      // priming was the cause of the "first attempt wrong, second right"
      // pattern users reported.
      for (let i = 0; i < CAM_PRIMING_FRAMES; i++) {
        sendCameraFrame();
        if (i < CAM_PRIMING_FRAMES - 1) {
          await new Promise((r) => setTimeout(r, CAM_PRIMING_INTERVAL_MS));
        }
      }
      return { ok: true };
    }
    case "disable_camera": {
      stopCamera();
      return { ok: true };
    }
    case "get_current_time": {
      const fmt = new Intl.DateTimeFormat("en-SG", {
        timeZone: "Asia/Singapore",
        hour: "numeric",
        minute: "2-digit",
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      emitRoom({ kind: "time_check" });
      return { ok: true, time: fmt.format(new Date()), iso: new Date().toISOString() };
    }
    case "identify_person_in_front": {
      // Phase-7 stub. Returning recognized:false makes Rayyy describe generically
      // and explicitly NOT fabricate a name. The honesty principle in code.
      emitRoom({ kind: "honesty_event", reason: "no_face_match" });
      return {
        recognized: false,
        reason: "no recognition data loaded yet",
      };
    }
    case "set_voice_provider": {
      // Phase 7 — REAL switch. Schedule the swap to happen after the current
      // turn's acknowledgement audio finishes playing. Then teardownWs() and
      // reopen with ?provider=<provider>. In elevenlabs mode the Worker sets
      // up Gemini with TEXT modality; the phone synthesizes via /tts/elevenlabs.
      const provider = ((_args && _args.provider) || "").toLowerCase();
      if (provider !== "elevenlabs" && provider !== "gemini") {
        emitRoom({ kind: "voice_switch", provider, ok: false });
        return { ok: false, message: "unknown provider" };
      }
      if (provider === currentProvider) {
        return { ok: true, provider, message: "already on " + provider };
      }
      pendingProviderSwitch = provider;
      emitRoom({ kind: "voice_switch", provider, ok: true });
      return { ok: true, provider, message: "switching to " + provider };
    }
    default:
      return { ok: false, error: "tool_not_implemented" };
  }
}

// ---------- room (Phase 5 dashboard pub/sub) ----------
// Phone is the writer. Privacy: intent triggers only — never verbatim speech.
let roomWs = null;
function openRoom() {
  try {
    const url = RELAY_BASE.replace(/^http/, "ws") + "/ws/auntie-mei?role=writer";
    roomWs = new WebSocket(url);
    roomWs.addEventListener("close", () => {
      roomWs = null;
    });
    roomWs.addEventListener("error", () => {});
  } catch (_) {}
}
function emitRoom(evt) {
  if (!roomWs || roomWs.readyState !== WebSocket.OPEN) return;
  try {
    roomWs.send(JSON.stringify(evt));
  } catch (_) {}
}

// ---------- base64 ----------
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length))
    );
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- websocket ----------
let wellbeingTimer = 0;
let lastSceneEmit = 0;

function openSession() {
  if (isConnecting() || isOpen()) return; // stacked-session guard
  teardownWs("reopen");

  setStatus("Connecting…");
  talkBtn.classList.add("live");
  if (!roomWs || roomWs.readyState !== WebSocket.OPEN) openRoom();

  const t0 = performance.now();
  // Append ?provider=<provider> so the Worker sets up the right modality.
  const wsUrl = `${WS_URL}?provider=${encodeURIComponent(currentProvider)}`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", async () => {
    const dt = Math.round(performance.now() - t0);
    setStatus(`Listening…  (open ${dt}ms)`);
    emitRoom({ kind: "conversation_start", openMs: dt });
    if (wellbeingTimer) clearInterval(wellbeingTimer);
    wellbeingTimer = setInterval(() => emitRoom({ kind: "wellbeing_tick" }), 30000);
    try {
      await startMicCapture();
    } catch (err) {
      setStatus("Mic error: " + err.message);
      teardownWs("mic error");
    }
  });

  ws.addEventListener("message", (event) => {
    handleServerMessage(event.data);
  });

  ws.addEventListener("close", (event) => {
    talkBtn.classList.remove("live");
    talkBtn.textContent = "Talk";
    isTalking = false;
    stopMicCapture();
    stopCamera();
    if (wellbeingTimer) {
      clearInterval(wellbeingTimer);
      wellbeingTimer = 0;
    }
    if (event.code !== 1000) {
      setStatus(`Closed (${event.code}) ${event.reason || ""}`.trim());
    } else {
      setStatus("Idle.");
    }
    ws = null;
  });

  ws.addEventListener("error", () => {
    setStatus("Connection error.");
  });
}

function handleServerMessage(data) {
  if (typeof data !== "string") {
    // Worker decodes upstream frames to text; binary is unexpected.
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (_) {
    return;
  }

  if (msg.setupComplete) {
    setStatus("Connected. Say hello.");
    return;
  }

  if (msg.toolCall) {
    handleToolCall(msg.toolCall);
    return;
  }

  // Barge-in: when the user starts talking, Gemini Live signals interrupted=true.
  // Stop any audio still queued from the previous turn so we don't play two
  // streams at once (which sounds like pitch wobble + speed wandering).
  if (msg?.serverContent?.interrupted) {
    flushAudio("server interrupt");
    pendingTextThisTurn = ""; // also drop any partial text in elevenlabs mode
    setStatus("Listening…");
  }

  // serverContent.modelTurn.parts[]:
  //   gemini provider:    parts[].inlineData.{mimeType, data}  (audio — play)
  //   elevenlabs provider: same audio shape, BUT we discard it. The actual
  //                        text we synthesize comes from
  //                        serverContent.outputTranscription.text further down.
  const parts = msg?.serverContent?.modelTurn?.parts;
  let gotAudio = false;
  if (Array.isArray(parts) && currentProvider === "gemini") {
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline && typeof inline.data === "string") {
        const rate = parseRateFromMime(inline.mimeType);
        playAudioChunk(inline.data, rate);
        gotAudio = true;
      }
    }
  }

  // ElevenLabs path: collect output transcription text as it streams.
  // We synthesize once turnComplete arrives.
  const outText = msg?.serverContent?.outputTranscription?.text;
  if (currentProvider === "elevenlabs" && typeof outText === "string" && outText) {
    pendingTextThisTurn += outText;
  }

  const gotText = currentProvider === "elevenlabs" && pendingTextThisTurn;
  if ((gotAudio || gotText) && statusEl.textContent !== "Rayyy is speaking…") {
    setStatus("Rayyy is thinking…");
    if (currentProvider === "gemini") {
      setTimeout(() => {
        if (isOpen()) setStatus("Rayyy is speaking…");
      }, SCHEDULE_LOOKAHEAD_S * 1000);
    }
  }

  if (msg?.serverContent?.turnComplete) {
    // Privacy: never forward what was said. Just emit a content-free
    // "scene_described" trigger if the camera was on this turn (throttled
    // to one per 5 seconds so a chatty back-and-forth doesn't spam the room).
    if (camActive) {
      const now = performance.now();
      if (now - lastSceneEmit > 5000) {
        lastSceneEmit = now;
        emitRoom({ kind: "scene_described" });
      }
    }

    // ElevenLabs path: the full reply text has been collected for this turn —
    // send it off for synthesis and play.
    if (currentProvider === "elevenlabs" && pendingTextThisTurn.trim()) {
      const text = pendingTextThisTurn.trim();
      pendingTextThisTurn = "";
      synthesizeWithElevenLabs(text);
    }

    // If a voice-provider switch is queued, perform it once the current
    // turn's audio has drained. We let the in-current-voice acknowledgement
    // ("OK, switching now") play out before tearing down the WS.
    if (pendingProviderSwitch) {
      const target = pendingProviderSwitch;
      pendingProviderSwitch = null;
      waitForAudioToDrain().then(() => switchProvider(target));
    } else {
      // Wait for the queued audio to finish, then go back to listening.
      setTimeout(() => {
        if (isOpen() && activeSources.length === 0 && !audioOut.duration)
          setStatus("Listening…");
      }, 200);
    }
  }

  // Input transcription is used LOCALLY only — never forwarded.
  // Detect "where am I" intent for the dashboard's location pin.
  const inText = msg?.serverContent?.inputTranscription?.text;
  if (inText && typeof inText === "string") {
    const lower = inText.toLowerCase();
    if (
      /\bwhere (am i|are we|is this)\b/.test(lower) ||
      /what (place|venue) is this/.test(lower) ||
      /what is this place/.test(lower)
    ) {
      emitRoom({ kind: "location_query" });
    }
  }
}

// ---------- talk button ----------
async function toggleTalk() {
  if (isConnecting()) return; // stacked-session guard
  if (isOpen()) {
    teardownWs("user stop");
    return;
  }
  await unlockAudio();
  openSession();
  isTalking = true;
  talkBtn.textContent = "Stop";
}

// ---------- start (permissions + warmup) ----------
async function onStart() {
  startBtn.disabled = true;
  setStatus("Requesting mic…");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    setStatus("Mic permission denied.");
    startBtn.disabled = false;
    return;
  }

  await unlockAudio();

  // Health check — confirms the relay is reachable and shows the active voice.
  try {
    const r = await fetch(RELAY_BASE + "/health", { cache: "no-store" });
    const j = await r.json();
    updateVoiceTag(j);
  } catch (_) {
    voiceTag.textContent = "Voice: relay unreachable";
  }

  startBtn.style.display = "none";
  talkBtn.disabled = false;
  setStatus("Ready. Tap Talk.");
}

startBtn.addEventListener("click", onStart);
talkBtn.addEventListener("click", toggleTalk);

// Spacebar + earbud-tap (MediaPlayPause) toggle Talk once started.
window.addEventListener("keydown", (e) => {
  if (talkBtn.disabled) return;
  if (e.code === "Space" || e.key === "MediaPlayPause") {
    e.preventDefault();
    toggleTalk();
  }
});
// iOS Safari sometimes intercepts MediaPlayPause; the on-screen Talk button covers that case.
