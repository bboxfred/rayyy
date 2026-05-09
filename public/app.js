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
function openSession() {
  if (isConnecting() || isOpen()) return; // stacked-session guard
  teardownWs("reopen");

  setStatus("Connecting…");
  talkBtn.classList.add("live");

  const t0 = performance.now();
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", async () => {
    const dt = Math.round(performance.now() - t0);
    setStatus(`Listening…  (open ${dt}ms)`);
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
    // No-op for Phase 2; Phase 5 dashboard will listen here.
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
