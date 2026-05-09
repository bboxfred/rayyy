// Rayyy.ai relay — Cloudflare Worker
// Phase 2: WebSocket proxy to Gemini Live v1alpha.
// Browser -> /ws -> this Worker -> Gemini Live.
// Worker injects: API key, model, system prompt, voice (Charon), basic config.
//
// Why a proxy and not the @google/genai SDK?
// The SDK didn't load reliably on iOS Safari from any CDN we tried.
// Raw WS is fewer moving parts and lets us keep the API key off the browser.

const GEMINI_WS_URL =
  "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

// Phase-4 system prompt — the full persona.
// Behavioral, not example-based. Rayyy must handle ANY phrasing of an intent.
// Mirror lives in system-prompt.md; keep them in sync.
const SYSTEM_INSTRUCTION = `You are Rayyy, the warm, patient voice companion for Auntie Mei.
You ride on her chest, she is blind, and she trusts you to be her eyes and her sense of the world today.

# WHO SHE IS
- Auntie Mei, 72, Chinese-Singaporean. Lives alone in Toa Payoh.
- Lost her sight five years ago to diabetic retinopathy.
- Daughter Ah-Hua lives in Punggol; calls every Saturday morning.
- Diabetic, sugar-limited diet, no peanuts.
- Husband Mr. Tan passed in 2019. Don't bring him up unless she does.
- Favourite hawker dish: Frog Porridge in Geylang.
- Goes to wet market every Tuesday and Friday morning.

# TODAY (Saturday May 16, 2026)
- She is at AI Engineer Singapore, Acacia College, 20 College Ave E.
- Many strangers around her.
- Her friend Kimberly is here today.
- She has a doctor's appointment with Dr. Tan at NUH at 4pm.
- Warm afternoon.

Use these facts naturally — never recite them. Reference them only when relevant.

# 7 CORE BEHAVIORS

1. IDENTITY — "who is this / who's in front of me / who am I looking at":
   Call enable_camera, then identify_person_in_front. If recognized, name them warmly.
   If not recognized, describe generically (e.g. "a man in a blue shirt, smiling"). NEVER fabricate a name.

2. LOCATION — "where are we / where am I / what place is this":
   Reference today's situation directly — venue, the crowd, that Kimberly is here.
   Brief and grounded; don't recite the address unless she asks.

3. OBJECT / SCENE — "what is this / what do you see / read this for me / what am I holding":
   Call enable_camera, wait for the frame, then describe.
   Describe text she can't feel: labels, expiry dates, signs, menus, mail, screens.
   DO NOT read Singapore currency notes — each denomination has a distinct size,
   she identifies them by feel. Reading them is a sighted-person assumption.
   After describing, call disable_camera.

4. TIME — "what time is it / is it late / how long until my doctor / when is Ah-Hua coming":
   Call get_current_time. Reply conversationally. For "how long until 4pm doctor",
   compute simply and say it short.

5. FACTUAL / CURRENT — weather, hawker hours, MRT, news, prices:
   Use google_search grounding. Reply briefly with the answer that matters,
   not the whole article.

6. VOICE SWITCH — "switch to ElevenLabs / use the other voice / change your voice":
   Call set_voice_provider with the requested provider name ("elevenlabs" or "gemini").
   If it returns ok:true, briefly acknowledge ("OK, switching now") in your CURRENT
   voice — the new voice takes over on the next reply. If it returns ok:false,
   tell her honestly. Never claim the switch happened if the tool said no.
   Voice CHARACTER stays locked between switches; you can adjust STYLE (more
   formal, slower pace) within the session in either provider.

7. CASUAL CONVERSATION — greetings, small talk, gratitude, feelings:
   Match her register. Reference what you know about her life when it fits.
   Never lecture. Never moralize. If she sounds tired or worried, ask gently.

# CROSS-CUTTING

DELIVERY (LOCKED — do not vary):
- Speak in clear, standard English. Calm, even, unhurried. Steady pitch and volume.
- No theatrical inflections. No speeding up. No slowing down. Same metronome on every turn.
- A short "yes can" beats a long explanation. Reply briefly — under 12 seconds spoken.

LANGUAGE — DEFAULT IS STANDARD ENGLISH:
- Default to clean, neutral, standard English. No Singlish particles by default.
- Switch to Mandarin instantly if she speaks Mandarin; stay there until she switches back.
- Switch to Singlish ONLY if she explicitly asks ("speak Singlish", "talk like a local")
  OR speaks Singlish to you herself. Once she's asked for it, sprinkle particles
  (lah, leh, ah, can, got) naturally for the rest of the session.
- She understands Hokkien but rarely speaks it; mirror only if she initiates.
- Language switching does NOT change delivery — same calm pace in any language.

STYLE adjustability: She can request a one-time change ("speak slower", "be more
formal") — apply it for that reply only, then RETURN to the locked baseline on the
next turn unless she explicitly says "keep that style".
Voice character itself is locked at session setup.

HONESTY: Never invent. If you don't see clearly, ask her to reposition. If a tool
returns "not implemented", tell her honestly. If you don't know, say "I'm not sure,
Auntie Mei" — never fill the gap with a guess.

PACE: Reply briefly — under 12 seconds spoken. Leave silence so she can think.
A short "yes can" beats a long explanation. If she asks something complex,
answer the practical part first, offer the rest if she wants more.

CALL HER "Auntie Mei" naturally — not every reply, just where it fits.`;

// Tool declarations. The model decides when to call these.
// `enable_camera` is the critical one — its handler in the client awaits the
// first frame before returning, so Rayyy cannot answer before he can see.
const TOOL_DECLARATIONS = [
  {
    name: "enable_camera",
    description:
      "Turn on the user's camera and capture the current scene. Blocks until at least one real frame has been delivered, so the model has actually seen something before responding. Call this BEFORE answering any visual question.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "disable_camera",
    description:
      "Turn off the user's camera once the visual task is finished. Saves battery and audio routing. Call this after describing what was seen.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "get_current_time",
    description:
      "Return the current local time in Singapore. Use when the user asks about time or how long until an upcoming event.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "identify_person_in_front",
    description:
      "After enable_camera has captured a frame, ask whether a known person is in view. Returns {recognized:false} if no match — in which case describe generically and NEVER fabricate a name.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "set_voice_provider",
    description:
      "Switch the speaking voice to a different provider (e.g. ElevenLabs). May return {ok:false, message:'not implemented'} — if so, tell the user honestly that voice switching isn't available yet.",
    parameters: {
      type: "OBJECT",
      properties: {
        provider: {
          type: "STRING",
          description: "Target provider, e.g. 'elevenlabs' or 'gemini'.",
        },
      },
      required: ["provider"],
    },
  },
];

// CORS allowlist. Use the stable production aliases, NOT per-deploy hash URLs.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:8787",
  "https://rayyy-aiengineer.vercel.app",
  "https://rayyy-smoketest.vercel.app", // legacy alias, kept until DNS settles
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          model: env.GEMINI_MODEL,
          voice: env.GEMINI_VOICE,
          providers: {
            gemini: { available: true, voice: env.GEMINI_VOICE },
            elevenlabs: {
              available: !!env.ELEVENLABS_API_KEY,
              voice_id: env.ELEVENLABS_VOICE_ID,
              model_id: env.ELEVENLABS_MODEL_ID,
            },
          },
          phase: 7,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    }

    if (url.pathname === "/tts/elevenlabs" && request.method === "POST") {
      if (!env.ELEVENLABS_API_KEY) {
        return new Response("ELEVENLABS_API_KEY not configured", { status: 500 });
      }
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return new Response("invalid json", { status: 400 });
      }
      const text = (body && body.text) || "";
      if (!text.trim()) return new Response("empty text", { status: 400 });
      const voiceId = env.ELEVENLABS_VOICE_ID;
      const modelId = env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=2&output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        }
      );
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => "");
        return new Response("elevenlabs error: " + upstream.status + " " + t, {
          status: 502,
          headers: corsHeaders(origin),
        });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          ...corsHeaders(origin),
        },
      });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      if (!env.GEMINI_API_KEY) {
        return new Response("GEMINI_API_KEY not configured", { status: 500 });
      }
      const provider = (url.searchParams.get("provider") || "gemini").toLowerCase();
      return handleGeminiProxy(request, env, provider);
    }

    if (url.pathname === "/ws/auntie-mei") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const id = env.AUNTIE_MEI_ROOM.idFromName("singleton");
      const stub = env.AUNTIE_MEI_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("rayyy-relay — Phase 2 voice loop\n", {
      headers: { "Content-Type": "text/plain", ...corsHeaders(origin) },
    });
  },
};

async function handleGeminiProxy(request, env, provider = "gemini") {
  // Browser <-> client side of pair
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();

  // Connect upstream to Gemini Live.
  // CRITICAL: outbound WS from a Worker uses an https:// URL with an Upgrade header,
  // then resp.webSocket.accept(). Don't use wss:// for the upstream URL.
  const upstreamUrl = new URL(GEMINI_WS_URL);
  upstreamUrl.searchParams.set("key", env.GEMINI_API_KEY);

  let upstream;
  try {
    const upstreamResp = await fetch(upstreamUrl.toString(), {
      headers: { Upgrade: "websocket" },
    });
    if (!upstreamResp.webSocket) {
      server.close(1011, "upstream did not return websocket");
      return new Response(null, { status: 101, webSocket: client });
    }
    upstream = upstreamResp.webSocket;
    upstream.accept();
  } catch (err) {
    server.close(1011, "upstream connect failed");
    return new Response(null, { status: 101, webSocket: client });
  }

  // Send setup message FIRST (Gemini Live requires this before any input).
  // For provider=elevenlabs, request TEXT modality from Gemini and let the
  // phone POST text to /tts/elevenlabs for audio. For provider=gemini (default),
  // request AUDIO modality with Charon/Aoede locked at session setup.
  // speechConfig MUST live inside generationConfig — top-level placement
  // returns 1007 "Unknown name speechConfig at setup".
  const isElevenLabs = provider === "elevenlabs";
  const generationConfig = isElevenLabs
    ? { responseModalities: ["TEXT"] }
    : {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: env.GEMINI_VOICE },
          },
        },
      };
  const setupMessage = {
    setup: {
      model: `models/${env.GEMINI_MODEL}`,
      generationConfig,
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      tools: [
        { functionDeclarations: TOOL_DECLARATIONS },
        { googleSearch: {} },
      ],
      // Input transcription is at the TOP level of `setup`, NOT inside
      // generationConfig — same kind of placement bug as speechConfig (1007).
      // The phone uses this LOCALLY for intent matching (e.g. "where am I"
      // -> dashboard location pulse). The phrase is never forwarded to the room.
      inputAudioTranscription: {},
    },
  };
  upstream.send(JSON.stringify(setupMessage));

  // Browser -> upstream
  server.addEventListener("message", (event) => {
    if (upstream.readyState !== WebSocket.READY_STATE_OPEN && upstream.readyState !== 1) return;
    try {
      // Forward as-is. Browser sends JSON strings (realtimeInput etc).
      upstream.send(event.data);
    } catch (_) {}
  });

  server.addEventListener("close", (event) => {
    try {
      upstream.close(event.code || 1000, event.reason || "client closed");
    } catch (_) {}
  });

  server.addEventListener("error", () => {
    try {
      upstream.close(1011, "client error");
    } catch (_) {}
  });

  // Upstream -> browser. Gemini Live frames arrive as Blob in CF Workers
  // (not ArrayBuffer or Uint8Array). Decode all three forms before forwarding
  // so the browser sees plain JSON strings.
  upstream.addEventListener("message", async (event) => {
    try {
      const data = await decodeFrame(event.data);
      // Surface any error/text frames in logs (audio is also text-decoded
      // here as base64 JSON; but anything mentioning "error" is interesting).
      if (typeof data === "string" && data.length < 600) {
        console.log("upstream msg:", data);
      }
      server.send(data);
    } catch (err) {
      console.log("upstream decode err:", String(err && err.message));
    }
  });

  upstream.addEventListener("close", (event) => {
    console.log("upstream close:", event.code, event.reason || "(no reason)");
    try {
      server.close(event.code || 1000, event.reason || "upstream closed");
    } catch (_) {}
  });

  upstream.addEventListener("error", () => {
    try {
      server.close(1011, "upstream error");
    } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ---------- AuntieMeiRoom (Durable Object) ----------
// Pub/sub room for the family dashboard. Phone connects as ?role=writer,
// dashboard connects as ?role=reader. Last 20 events are replayed on join
// so a fresh reader gets context.
//
// Privacy invariant: events are intent triggers only — never verbatim speech.
// The phone is responsible for upholding this; the room just relays.
export class AuntieMeiRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.readers = new Set();
    this.recent = []; // last 20 events, in order
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "reader";

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (role === "reader") {
      this.readers.add(server);
      // Replay recent events so the dashboard catches up.
      for (const evt of this.recent) {
        try {
          server.send(JSON.stringify(evt));
        } catch (_) {}
      }
      server.addEventListener("close", () => this.readers.delete(server));
      server.addEventListener("error", () => this.readers.delete(server));
    } else {
      // writer (phone)
      server.addEventListener("message", (event) => {
        let evt;
        try {
          evt = typeof event.data === "string" ? JSON.parse(event.data) : null;
        } catch (_) {
          return;
        }
        if (!evt || typeof evt !== "object") return;
        evt.ts = evt.ts || Date.now();
        this.recent.push(evt);
        if (this.recent.length > 20) this.recent.shift();
        this.broadcast(evt);
      });
      server.addEventListener("close", () => {});
      server.addEventListener("error", () => {});
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(evt) {
    const payload = JSON.stringify(evt);
    for (const ws of this.readers) {
      try {
        ws.send(payload);
      } catch (_) {
        this.readers.delete(ws);
      }
    }
  }
}

async function decodeFrame(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  // Blob path — common in CF Workers for incoming WS frames.
  if (data && typeof data.text === "function") {
    return await data.text();
  }
  if (data && typeof data.arrayBuffer === "function") {
    const buf = await data.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(buf));
  }
  return String(data);
}
