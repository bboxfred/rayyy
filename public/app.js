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
const startBtn = document.getElementById("start-btn"); // optional; new layout doesn't have one
const talkBtn = document.getElementById("talk-btn");
const statusEl = document.getElementById("status");
const voiceTag = document.getElementById("voice-tag");
const audioOut = document.getElementById("audio-out");
const viewfinderCard = document.getElementById("viewfinder-card");
const viewfinderCanvas = document.getElementById("viewfinder");
const viewfinderCaption = document.getElementById("viewfinder-caption");
const actionCallBtn = document.getElementById("action-call");
const actionMapsBtn = document.getElementById("action-maps");
const actionEmergencyBtn = document.getElementById("action-emergency");
const scenarioOverlay = document.getElementById("scenario-overlay");
const scenarioIcon = document.getElementById("scenario-icon");
const scenarioTitle = document.getElementById("scenario-title");
const scenarioSub = document.getElementById("scenario-sub");
const scenarioCloseBtn = document.getElementById("scenario-close");

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
let pendingInputTranscript = ""; // running transcription of the user's CURRENT utterance — local-only, never forwarded
let elevenlabsAudioUrl = null; // current blob URL for cleanup

// face matching state (Phase 8)
let faceModelsReady = false;
let faceMatcher = null;
let faceModelsPromise = null;
const KIMBERLY_REFERENCE_PATHS = [
  "/assets/kimberly-1.jpeg",
  "/assets/kimberly-2.jpeg",
  "/assets/kimberly-3.jpeg",
];
// FaceMatcher distance threshold — LOWER is stricter. 0.55 is a balanced
// default that gates against false positives while still matching across
// modest pose / lighting variation. The matcher contains ONLY Kimberly,
// so a stranger gets best.label === "unknown" and we return recognized:false.
const FACE_MATCH_THRESHOLD = 0.55;

// Descriptor cache: persist the 128-dim embeddings in localStorage so we
// never have to re-run face-detection on the reference photos after the
// first session. Bump REF_VERSION if the photos change.
const FACE_CACHE_KEY = "rayyy_face_descriptors_v1";
const FACE_REF_VERSION = KIMBERLY_REFERENCE_PATHS.join("|") + "|v1";

function loadDescriptorsFromCache() {
  try {
    const raw = localStorage.getItem(FACE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== FACE_REF_VERSION) return null;
    if (!Array.isArray(parsed.descriptors) || parsed.descriptors.length === 0)
      return null;
    return parsed.descriptors.map((a) => new Float32Array(a));
  } catch (_) {
    return null;
  }
}

function saveDescriptorsToCache(descriptors) {
  try {
    localStorage.setItem(
      FACE_CACHE_KEY,
      JSON.stringify({
        version: FACE_REF_VERSION,
        descriptors: descriptors.map((d) => Array.from(d)),
        ts: Date.now(),
      })
    );
  } catch (_) {}
}

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

// ---------- face matching (Phase 8) ----------
// Browser-only, no server side. face-api.js loads from CDN, then we compute
// 128-dim face descriptors from the 3 Kimberly reference photos at session
// start. When identify_person_in_front fires, we capture the current
// viewfinder canvas, run face detection + descriptor, and compare via
// FaceMatcher (Euclidean distance). Threshold-gated to avoid false positives.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load " + src));
    img.src = src;
  });
}

async function ensureFaceModels() {
  if (faceModelsReady) return true;
  if (faceModelsPromise) return faceModelsPromise;
  faceModelsPromise = (async () => {
    if (!window.faceapi) {
      await loadScript(
        "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js"
      );
    }
    const MODEL_URL =
      "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);

    // Try the descriptor cache first — if the same photos were processed in
    // a previous session, restore from localStorage and skip face-detection
    // on the reference images entirely (~1.5s saved).
    let refDescriptors = loadDescriptorsFromCache();
    if (refDescriptors && refDescriptors.length > 0) {
      console.log(
        "[face] loaded",
        refDescriptors.length,
        "Kimberly references from cache"
      );
    } else {
      refDescriptors = [];
      for (const path of KIMBERLY_REFERENCE_PATHS) {
        try {
          const img = await loadImageEl(path);
          const det = await faceapi
            .detectSingleFace(
              img,
              new faceapi.TinyFaceDetectorOptions({
                inputSize: 416,
                scoreThreshold: 0.3,
              })
            )
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (det) refDescriptors.push(det.descriptor);
        } catch (err) {
          console.warn("[face] reference load failed:", path, err);
        }
      }
      if (refDescriptors.length === 0) {
        throw new Error("no Kimberly reference faces could be processed");
      }
      saveDescriptorsToCache(refDescriptors);
      console.log(
        "[face] computed + cached",
        refDescriptors.length,
        "Kimberly references"
      );
    }

    faceMatcher = new faceapi.FaceMatcher(
      [new faceapi.LabeledFaceDescriptors("Kimberly", refDescriptors)],
      FACE_MATCH_THRESHOLD
    );
    faceModelsReady = true;
    return true;
  })();
  return faceModelsPromise;
}

// Run the match against the current viewfinder canvas.
async function runFaceMatch() {
  await ensureFaceModels();
  if (!faceMatcher) return { match: false, reason: "no references loaded" };
  if (!camActive || !viewfinderCanvas.width) {
    return { match: false, reason: "camera not active" };
  }
  const det = await faceapi
    .detectSingleFace(
      viewfinderCanvas,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.35,
      })
    )
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!det) return { match: false, reason: "no face detected in frame" };
  const best = faceMatcher.findBestMatch(det.descriptor);
  if (best.label === "unknown") {
    return {
      match: false,
      reason: "face detected but did not match Kimberly",
      distance: best.distance,
    };
  }
  // FaceMatcher returns distance (lower = more similar). Convert to
  // confidence in [0, 1] where 1 = identical.
  const confidence = Math.max(0, 1 - best.distance);
  return { match: true, label: best.label, confidence, distance: best.distance };
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
      // Phase 8 — real face matching against Kimberly references.
      // The model called this AFTER enable_camera, so the viewfinder canvas
      // already has a focused frame painted on it.
      try {
        const result = await runFaceMatch();
        if (result.match) {
          emitRoom({
            kind: "recognition",
            who: result.label,
            confidence: Number(result.confidence.toFixed(2)),
          });
          return {
            recognized: true,
            name: result.label,
            confidence: Number(result.confidence.toFixed(2)),
          };
        }
        // No match -> honesty stub so Rayyy describes generically and never
        // fabricates a name. Pass the reason for debug visibility.
        emitRoom({ kind: "honesty_event", reason: result.reason });
        return {
          recognized: false,
          reason: result.reason,
        };
      } catch (err) {
        emitRoom({ kind: "honesty_event", reason: "match_error" });
        return {
          recognized: false,
          reason: "face matching error: " + (err && err.message),
        };
      }
    }
    case "trigger_quick_action": {
      const action = ((_args && _args.action) || "").toLowerCase();
      switch (action) {
        case "quick_call":
          runQuickCall();
          return { ok: true, action };
        case "enquire_maps":
          runEnquireMaps();
          return { ok: true, action };
        case "emergency":
          runEmergency();
          return { ok: true, action };
        default:
          return { ok: false, error: "unknown_action" };
      }
    }
    case "customize_button": {
      const slot = ((_args && _args.slot) || "").toLowerCase();
      if (!actionConfig[slot]) return { ok: false, error: "unknown_slot" };
      const next = { ...actionConfig[slot] };
      if (_args.label) next.label = _args.label;
      if (_args.target) next.target = _args.target;
      if (_args.phone) next.phone = _args.phone;
      // For emergency, allow updating primary/fallback fields too.
      if (slot === "emergency") {
        if (_args.target) next.primary = _args.target;
        if (_args.phone) next.primary_phone = _args.phone;
      }
      actionConfig[slot] = next;
      saveActionConfig(actionConfig);
      // Refresh the visible label on the button.
      const btn = document.querySelector(`[data-action="${slot}"] .action-label`);
      if (btn && next.label) btn.textContent = next.label;
      return { ok: true, slot, config: next };
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
    setTalkLabel("Talk");
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
    pendingInputTranscript = ""; // user is starting fresh — drop running transcript
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
    // Reset the running user-utterance transcript so the next utterance
    // doesn't accumulate on top of the previous one.
    pendingInputTranscript = "";
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

  // Input transcription is used LOCALLY only — never forwarded. Gemini
  // streams it incrementally, often a few words at a time, so we BUFFER
  // per-turn and match the running text. Buffer resets on turnComplete
  // (above) and on barge-in.
  const inText = msg?.serverContent?.inputTranscription?.text;
  if (inText && typeof inText === "string") {
    pendingInputTranscript = (pendingInputTranscript + " " + inText)
      .replace(/\s+/g, " ")
      .trim();
    const running = pendingInputTranscript
      .toLowerCase()
      .replace(/[.!?,]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Dashboard location pin
    if (
      /\bwhere (am i|are we|is this)\b/.test(running) ||
      /what (place|venue) is this/.test(running) ||
      /what is this place/.test(running)
    ) {
      emitRoom({ kind: "location_query" });
    }

    // Auto-stop on closing phrases. We test patterns that ANCHOR to the END
    // of the running utterance ($), so "thanks for that, where am I" never
    // matches, but "ok thanks" / "alright bye" / "see you Rayyy" does.
    const enderPatterns = [
      /\bthat'?s? all\s*$/,
      /\bi'?m done\s*$/,
      /\bstop listening\s*$/,
      /\bgood ?bye\s*$/,
      /\bbye(\s+rayyy)?\s*$/,
      /\bsee (you|ya)( later)?( rayyy)?\s*$/,
      /\bthanks?(\s+rayyy)?\s*$/,
      /\bthank you(\s+rayyy)?\s*$/,
      /\balright(\s+(bye|then))?\s*$/,
      /\bcheers\s*$/,
      /\bok(ay)? bye\s*$/,
    ];
    if (enderPatterns.some((p) => p.test(running))) {
      setStatus("Goodbye, Auntie Mei.");
      pendingInputTranscript = "";
      setTimeout(() => {
        teardownWs("user said goodbye");
      }, 300);
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
  setTalkLabel("Stop");
}

// The new talk button has an icon + label span; setTalkLabel() updates only
// the label so we don't clobber the icon.
function setTalkLabel(text) {
  const labelEl = talkBtn.querySelector(".talk-label");
  if (labelEl) labelEl.textContent = text;
  else talkBtn.textContent = text;
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
  // Hide the judge-facing intro/try-it cards once a session is live so the
  // status + controls + viewfinder become the focus.
  document.body.classList.add("session-active");
  setStatus("Ready. Tap Talk.");

  // Preload face-matching models in the background so the first
  // identify_person_in_front call doesn't have to wait for ~6MB of weights.
  ensureFaceModels().catch((err) => {
    console.warn("[face] preload failed:", err && err.message);
  });
}

// ---------- quick-action scenarios ----------
// Each action is a customizable scripted flow. Default config is hardcoded
// here; AI tool calls (and future verbal customization) update localStorage.
const ACTION_CONFIG_KEY = "rayyy_action_config_v1";
const DEFAULT_ACTION_CONFIG = {
  quick_call: { label: "Quick Call", target: "Ah-Hua", phone: "9123 4567" },
  enquire_maps: { label: "Maps", target: "current location" },
  emergency: {
    label: "Emergency",
    primary: "Ah-Hua",
    primary_phone: "9123 4567",
    fallback: "SCDF 995",
    ring_seconds: 5,
  },
};
function loadActionConfig() {
  try {
    const raw = localStorage.getItem(ACTION_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_ACTION_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ACTION_CONFIG, ...parsed };
  } catch (_) {
    return { ...DEFAULT_ACTION_CONFIG };
  }
}
function saveActionConfig(cfg) {
  try {
    localStorage.setItem(ACTION_CONFIG_KEY, JSON.stringify(cfg));
  } catch (_) {}
}
let actionConfig = loadActionConfig();

let scenarioActive = false;
let scenarioTimers = [];
function clearScenarioTimers() {
  for (const t of scenarioTimers) clearTimeout(t);
  scenarioTimers = [];
}
function showScenario({ icon, title, sub, emergency = false }) {
  scenarioIcon.textContent = icon;
  scenarioTitle.textContent = title;
  scenarioSub.textContent = sub || "";
  scenarioOverlay.classList.toggle("emergency", !!emergency);
  scenarioOverlay.classList.add("show");
  scenarioActive = true;
}
function updateScenario({ title, sub, icon }) {
  if (icon) scenarioIcon.textContent = icon;
  if (title) scenarioTitle.textContent = title;
  if (sub !== undefined) scenarioSub.textContent = sub;
}
function hideScenario() {
  scenarioOverlay.classList.remove("show");
  scenarioOverlay.classList.remove("emergency");
  scenarioActive = false;
  clearScenarioTimers();
  stopRinging();
  stopScenarioClip();
  try { speechSynthesis?.cancel(); } catch (_) {}
}
scenarioCloseBtn?.addEventListener("click", hideScenario);

// Synthesize a phone-ring tone. Two short tones (480Hz + 440Hz) = classic
// dual-tone ring; cadence is ring-ring, pause, ring-ring etc.
let ringingNodes = [];
function startRinging(durationSec = 6) {
  if (!outCtx) ensureOutputContext();
  stopRinging();
  const ctx = outCtx;
  const t0 = ctx.currentTime;
  const cadence = 2.0; // seconds per ring cycle
  const ringOn = 0.4; // seconds of tone
  const cycles = Math.ceil(durationSec / cadence);
  const master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);
  ringingNodes.push(master);
  for (let i = 0; i < cycles; i++) {
    const start = t0 + i * cadence;
    const stop = start + ringOn;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = "sine";
    o2.type = "sine";
    o1.frequency.value = 480;
    o2.frequency.value = 440;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + 0.04);
    env.gain.setValueAtTime(1, stop - 0.04);
    env.gain.linearRampToValueAtTime(0, stop);
    o1.connect(env);
    o2.connect(env);
    env.connect(master);
    o1.start(start);
    o2.start(start);
    o1.stop(stop);
    o2.stop(stop);
    ringingNodes.push(o1, o2, env);
  }
}
function stopRinging() {
  for (const n of ringingNodes) {
    try { n.stop?.(0); n.disconnect?.(); } catch (_) {}
  }
  ringingNodes = [];
}

// Browser TTS for the pre-recorded scenario messages. Picks a voice that's
// ideally NOT the same as Rayyy's Aoede/Louis so it sounds like a different
// person on the line.
function pickSpeechVoice(preferGender = "female") {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  // Prefer en-* voices first.
  const enVoices = voices.filter((v) => /^en/i.test(v.lang));
  const pool = enVoices.length ? enVoices : voices;
  // Try to bias by gender via name heuristic.
  const femaleNames = /samantha|karen|moira|tessa|fiona|martha|alice|kate|google.+female|amy|kathy/i;
  const maleNames = /daniel|fred|alex|tom|aaron|google.+male|matthew|david/i;
  const match = pool.find((v) =>
    preferGender === "female" ? femaleNames.test(v.name) : maleNames.test(v.name)
  );
  return match || pool[0] || null;
}
function speakMessage(text, opts = {}) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    try { speechSynthesis.cancel(); } catch (_) {}
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = opts.rate || 1.0;
    utter.pitch = opts.pitch || 1.0;
    const voice = pickSpeechVoice(opts.gender || "female");
    if (voice) utter.voice = voice;
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    speechSynthesis.speak(utter);
  });
}

// Play a scripted ElevenLabs clip — used for scenarios (call answered,
// emergency punchline, etc). Routes through /tts/elevenlabs with optional
// voice settings so we can dial in "agitated" / "dry" character.
let scenarioAudioUrl = null;
let scenarioAudioEl = null;
async function playElevenLabsClip(text, opts = {}) {
  try {
    const r = await fetch(RELAY_BASE + "/tts/elevenlabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: opts.voice_id || undefined,
        voice_settings: opts.voice_settings || undefined,
      }),
    });
    if (!r.ok) return false;
    const blob = await r.blob();
    if (scenarioAudioUrl) URL.revokeObjectURL(scenarioAudioUrl);
    scenarioAudioUrl = URL.createObjectURL(blob);
    // Use a separate audio element so we don't clash with audioOut, which is
    // bound to the AudioContext stream during a live Rayyy session.
    if (!scenarioAudioEl) {
      scenarioAudioEl = document.createElement("audio");
      scenarioAudioEl.playsInline = true;
      scenarioAudioEl.autoplay = true;
    }
    scenarioAudioEl.src = scenarioAudioUrl;
    scenarioAudioEl.playbackRate = 1.0;
    return new Promise((resolve) => {
      scenarioAudioEl.onended = () => resolve(true);
      scenarioAudioEl.onerror = () => resolve(false);
      scenarioAudioEl.play().catch(() => resolve(false));
    });
  } catch (_) {
    return false;
  }
}
function stopScenarioClip() {
  try {
    if (scenarioAudioEl) {
      scenarioAudioEl.pause();
      scenarioAudioEl.removeAttribute("src");
      scenarioAudioEl.load();
    }
  } catch (_) {}
}

async function runQuickCall() {
  const cfg = actionConfig.quick_call;
  showScenario({
    icon: "📞",
    title: `Calling ${cfg.target}…`,
    sub: cfg.phone || "",
  });
  emitRoom({ kind: "voice_switch", provider: "quick_call", ok: true });
  startRinging(3);
  scenarioTimers.push(
    setTimeout(async () => {
      if (!scenarioActive) return;
      stopRinging();
      updateScenario({
        icon: "✅",
        title: `${cfg.target} picked up`,
        sub: "(answering…)",
      });
      // ElevenLabs Louis voice (Singaporean accent), tuned to "agitated":
      // very low stability + high style produces lots of emotional inflection.
      // Cleaner punctuation + line breaks help the model push the energy.
      await playElevenLabsClip(
        "Eh! Mei ah! I busy now lah! I catching frogs! Eh, call you back later! Bye bye!",
        {
          voice_settings: {
            stability: 0.18,
            similarity_boost: 0.85,
            style: 0.7,
            use_speaker_boost: true,
          },
        }
      );
      if (!scenarioActive) return;
      updateScenario({ icon: "🔚", title: "Call ended", sub: "" });
      scenarioTimers.push(setTimeout(hideScenario, 1300));
    }, 3000)
  );
}

async function runEnquireMaps() {
  // Open a session if needed, then ask Rayyy to say a specific opening
  // line and stay listening for follow-ups (where to navigate to, etc).
  if (!isOpen()) {
    if (!micStream) {
      try {
        await ensurePermissionsAndUnlock();
      } catch (err) {
        setStatus("Mic permission needed for Maps.");
        return;
      }
    }
    await unlockAudio();
    openSession();
    await waitFor(() => isOpen(), 4000);
  }
  if (!isOpen()) {
    setStatus("Couldn't connect for Maps.");
    return;
  }
  const prompt =
    "The user just tapped the Maps button. Say to her, in your current " +
    "voice, exactly: \"We are at Acacia College at NUS. Do you need " +
    "directions to anywhere?\" Then wait for her reply and help her " +
    "navigate from there.";
  try {
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: prompt }] }],
          turnComplete: true,
        },
      })
    );
    setStatus("Asking Rayyy for directions…");
    emitRoom({ kind: "location_query" });
  } catch (_) {}
}

async function runEmergency() {
  const cfg = actionConfig.emergency;
  showScenario({
    icon: "🚨",
    title: `Calling ${cfg.primary}…`,
    sub: `Emergency contact · ${cfg.primary_phone || ""}`,
    emergency: true,
  });
  emitRoom({ kind: "voice_switch", provider: "emergency_call", ok: true });

  const ringSec = cfg.ring_seconds || 4;
  startRinging(ringSec);

  // Phase 1: primary contact rings, no answer.
  scenarioTimers.push(
    setTimeout(() => {
      if (!scenarioActive) return;
      stopRinging();
      updateScenario({
        icon: "⏱",
        title: `${cfg.primary} not answering…`,
        sub: "Switching to emergency services.",
      });
    }, ringSec * 1000)
  );

  // Phase 2: switch to SCDF — start ringing again.
  scenarioTimers.push(
    setTimeout(() => {
      if (!scenarioActive) return;
      updateScenario({
        icon: "🚑",
        title: `Calling ${cfg.fallback}…`,
        sub: "Singapore Civil Defence Force",
      });
      startRinging(2.4);
    }, (ringSec + 1.6) * 1000)
  );

  // Phase 3: SCDF "answers" with the punchline.
  scenarioTimers.push(
    setTimeout(async () => {
      if (!scenarioActive) return;
      stopRinging();
      updateScenario({
        icon: "🎤",
        title: "Connected",
        sub: "(picking up…)",
      });
      // Brian — "Deep, Resonant and Comforting" American voice. Sounds
      // like a real emergency dispatcher, then drops the deadpan
      // "hackathon lah" punchline. Calmer voice settings: medium stability,
      // low style for a dry / matter-of-fact delivery.
      await playElevenLabsClip(
        "Eh hello? I won't call SCDF for a hackathon lah!",
        {
          voice_id: "nPczCjzI2devNBz1zQrb",
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.8,
            style: 0.25,
            use_speaker_boost: true,
          },
        }
      );
      if (!scenarioActive) return;
      updateScenario({ icon: "🔚", title: "Call ended", sub: "" });
      scenarioTimers.push(setTimeout(hideScenario, 1300));
    }, (ringSec + 4.0) * 1000)
  );
}

// Permissions + audio unlock — called from the Talk button on first use
// (the new layout doesn't have a separate Tap-to-Start button).
async function ensurePermissionsAndUnlock() {
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
  await unlockAudio();
  // Voice tag
  try {
    const r = await fetch(RELAY_BASE + "/health", { cache: "no-store" });
    const j = await r.json();
    updateVoiceTag(j);
  } catch (_) {
    voiceTag.textContent = "Voice: relay unreachable";
  }
  // Preload face matching weights in the background
  ensureFaceModels().catch(() => {});
  document.body.classList.add("session-active");
}

// Talk button is the SOLE entry point in the new layout — first tap grants
// mic + camera and opens a session.
async function onTalkPress() {
  if (scenarioActive) return; // ignore while a scenario overlay is up
  if (isConnecting()) return;
  try {
    await ensurePermissionsAndUnlock();
  } catch (err) {
    setStatus("Mic permission denied.");
    return;
  }
  if (isOpen()) {
    teardownWs("user stop");
    return;
  }
  openSession();
  setTalkLabel("Stop");
}

talkBtn.addEventListener("click", onTalkPress);
if (startBtn) startBtn.addEventListener("click", onStart);
actionCallBtn?.addEventListener("click", runQuickCall);
actionMapsBtn?.addEventListener("click", runEnquireMaps);
actionEmergencyBtn?.addEventListener("click", runEmergency);

// Two-screen flow: tapping "Get started" reveals the try-it section + controls.
const continueBtn = document.getElementById("continue-btn");
if (continueBtn) {
  continueBtn.addEventListener("click", () => {
    document.body.classList.add("intro-passed");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Spacebar + earbud-tap (MediaPlayPause) toggle Talk once started.
window.addEventListener("keydown", (e) => {
  if (talkBtn.disabled) return;
  if (e.code === "Space" || e.key === "MediaPlayPause") {
    e.preventDefault();
    toggleTalk();
  }
});
// iOS Safari sometimes intercepts MediaPlayPause; the on-screen Talk button covers that case.

// Preload face-matching models on page load so they're ready by the time
// the judge taps Talk. Browser HTTP cache handles the ~6MB of weights on
// repeat visits; descriptors are cached in localStorage so we don't even
// re-run face-detection on the reference photos.
window.addEventListener("load", () => {
  ensureFaceModels()
    .then(() => {
      console.log("[face] preload complete on page load");
    })
    .catch((err) => {
      console.warn("[face] preload on page load failed:", err && err.message);
    });
});
