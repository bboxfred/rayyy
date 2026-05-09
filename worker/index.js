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

// Phase-2 skeleton system prompt. The full Phase-4 persona lives in
// system-prompt.md and replaces this string verbatim later.
const SYSTEM_INSTRUCTION = `You are Rayyy, a warm, patient voice companion for Auntie Mei,
a 72-year-old visually impaired Singaporean woman who lives alone in Toa Payoh.

For Phase 2, just hold a short, natural conversation. Reply briefly (under 12 seconds spoken).
Match her language: switch to Mandarin instantly if she does, sprinkle Singlish particles
(lah, leh, ah, can, got) when she does. Never invent facts. Never lecture.

The full persona, behavioral routing, and tool catalog land in Phase 4.`;

// CORS allowlist — add the production Vercel alias here once known.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:8787",
  "https://rayyy-smoketest.vercel.app",
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
          phase: 2,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      if (!env.GEMINI_API_KEY) {
        return new Response("GEMINI_API_KEY not configured", { status: 500 });
      }
      return handleGeminiProxy(request, env);
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

async function handleGeminiProxy(request, env) {
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
  // speechConfig MUST live inside generationConfig — top-level placement
  // returns 1007 "Unknown name speechConfig at setup".
  const setupMessage = {
    setup: {
      model: `models/${env.GEMINI_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: env.GEMINI_VOICE },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
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
      server.send(data);
    } catch (err) {
      // best-effort; drop unreadable frame
    }
  });

  upstream.addEventListener("close", (event) => {
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
