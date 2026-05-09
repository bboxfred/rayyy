// Rayyy.ai phone client — Phase 2 voice loop.
//
// Flow:
//   Tap to start  -> getUserMedia({audio}) + unlock AudioContext + load /health
//   Talk          -> open WS to Worker /ws, stream mic PCM16 @ 16kHz
//                    receive audio frames, decode base64 PCM16 @ 24kHz, resample to
//                    outCtx.sampleRate, schedule on a MediaStreamDestination ->
//                    <audio> sink (the only iOS-safe routing).
//
// Hard rules baked in here (each one is a real bug we already paid for):
//   - speechConfig is set server-side. Client never touches it.
//   - Output goes through MediaStreamDestination -> <audio>, never AudioContext.destination.
//   - Pre-resample to outCtx.sampleRate; iOS often ignores requested rate.
//   - Reset nextStartTime = outCtx.currentTime on AudioContext resume.
//   - Block stacked sessions: ignore Talk while ws.readyState === CONNECTING; tear down old WS first.

// ---------- config ----------
const RELAY_BASE = inferRelayBase();
const WS_URL = RELAY_BASE.replace(/^http/, "ws") + "/ws";

const INPUT_SAMPLE_RATE = 16000; // Gemini Live wants 16kHz mono PCM16 in
const OUTPUT_SAMPLE_RATE = 24000; // Gemini Live emits 24kHz mono PCM16 out

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
let outDest = null; // MediaStreamDestination — iOS-safe sink
let micProcessor = null;
let micSource = null;
let ws = null;
let isTalking = false;
let nextStartTime = 0;

// camera state
let camStream = null;
let camVideo = null; // off-DOM <video>, painted to canvas via rAF
let camRafId = 0;
let camFrameTimer = 0; // setInterval id for periodic 1fps frame send
let camAutoOffTimer = 0; // 15s backstop
let camActive = false;
const CAM_AUTO_OFF_MS = 15000;
const CAM_FRAME_INTERVAL_MS = 1000; // 1 fps to Gemini while looking
const CAM_AUTOFOCUS_PAUSE_MS = 800;

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
function ensureOutputContext() {
  if (outCtx && outCtx.state !== "closed") return outCtx;
  outCtx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "playback",
  });
  outDest = outCtx.createMediaStreamDestination();
  audioOut.srcObject = outDest.stream;
  // Reset queue clock on any resume so we don't schedule in the past.
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
  // Force the <audio> sink to start so iOS commits to media-playback routing.
  try {
    await audioOut.play();
  } catch (_) {}
  nextStartTime = outCtx.currentTime;
}

// Decode base64 PCM16 @ 24kHz, linearly resample to outCtx.sampleRate, schedule.
function playAudioChunk(base64Pcm) {
  if (!outCtx || !outDest) return;
  const bytes = base64ToBytes(base64Pcm);
  if (bytes.length < 2) return;

  // PCM16LE -> Float32
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const inFloat = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) inFloat[i] = samples[i] / 32768;

  // Linear resample 24kHz -> outCtx.sampleRate (whatever iOS actually gave us).
  const targetRate = outCtx.sampleRate;
  const outFloat = linearResample(inFloat, OUTPUT_SAMPLE_RATE, targetRate);

  const buffer = outCtx.createBuffer(1, outFloat.length, targetRate);
  buffer.copyToChannel(outFloat, 0);

  const node = outCtx.createBufferSource();
  node.buffer = buffer;
  node.connect(outDest);

  const now = outCtx.currentTime;
  if (nextStartTime < now) nextStartTime = now;
  node.start(nextStartTime);
  nextStartTime += buffer.duration;
}

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
    ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }],
        },
      })
    );
  };

  micSource.connect(micProcessor);
  micProcessor.connect(inCtx.destination);
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
        mediaChunks: [{ mimeType: "image/jpeg", data: base64 }],
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
      // Force one frame NOW and only resolve once it's been shipped.
      sendCameraFrame();
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
      // Phase-6 stub. Honest "not implemented" so Rayyy tells the user the truth
      // instead of faking compliance with the same Charon voice.
      emitRoom({ kind: "voice_switch", provider: _args && _args.provider });
      return {
        ok: false,
        message: "voice_switching_not_implemented_yet",
      };
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
  ws = new WebSocket(WS_URL);

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

  // serverContent.modelTurn.parts[].inlineData.{mimeType, data}
  const parts = msg?.serverContent?.modelTurn?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline && typeof inline.data === "string") {
        // Gemini Live audio is PCM16 @ 24kHz. mimeType looks like "audio/pcm;rate=24000"
        playAudioChunk(inline.data);
      }
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

  // Health check — confirms the relay is reachable and shows the locked voice.
  try {
    const r = await fetch(RELAY_BASE + "/health", { cache: "no-store" });
    const j = await r.json();
    voiceTag.textContent = `Voice: ${j.voice} · ${j.model}`;
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
