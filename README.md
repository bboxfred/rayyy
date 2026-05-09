# Rayyy.ai

A multilingual voice + vision AI companion for elderly visually impaired people,
**plus** a real-time family dashboard that lets a sighted family member follow along.

> Built for the **AI Engineer Singapore** hackathon.
> Targeting Gemini Best Voice Agent track and Overall.

---

## Live demo

| Surface | URL | Who's it for |
|---|---|---|
| **Phone** | [rayyy-aiengineer.vercel.app](https://rayyy-aiengineer.vercel.app/) | Auntie Mei — voice agent, mic, camera, speaker / earbuds |
| **Family dashboard** | [rayyy-aiengineer.vercel.app/dashboard](https://rayyy-aiengineer.vercel.app/dashboard) | Ah-Hua, her daughter — and the projector audience |
| **Projector backup** | [/dashboard?fake=true](https://rayyy-aiengineer.vercel.app/dashboard?fake=true) | 32-second scripted timeline if venue Wi-Fi dies |
| **Worker health** | [rayyy-relay.fred-53e.workers.dev/health](https://rayyy-relay.fred-53e.workers.dev/health) | Lock-in confirmation: model + voice |

---

## What it does

Auntie Mei is a 72-year-old Singaporean woman in Toa Payoh. She's been blind for five
years. She straps a phone to her chest and Rayyy talks back to her — patient, warm,
in whatever language she switches to mid-sentence.

When she asks anything visual ("who's that ah?", "what is this?", "read this for me"),
Rayyy turns the camera on, waits for a real frame to arrive, then describes what it sees.
He never invents a name. He never reads Singapore currency notes — she identifies those
by feel, and reading them is a sighted-person assumption.

Meanwhile her daughter, on the dashboard, watches the day unfold. **No words leave the
device.** The dashboard receives only intent triggers — "she started a conversation",
"she asked where she was", "Rayyy looked at something" — and reacts in real time.
Topics light up, the map pin pulses, the wellbeing line nudges. Privacy by design.

---

## Architecture

```
┌──────────────────────────┐
│ PHONE (mobile web app)   │
│   mic, camera, earbuds   │
└──┬─────────────────────┬─┘
   │ Gemini Live WS      │ Room WS (writer)
   ▼                     ▼
┌──────────────────────────────────────────┐
│ CLOUDFLARE WORKER (rayyy-relay)          │
│   /ws            → Gemini Live proxy     │
│   /ws/auntie-mei → AuntieMeiRoom DO      │
│   /health        → live config readout   │
└──┬─────────────────────┬─────────────────┘
   │ wss + key           │ broadcasts
   ▼                     ▼
┌─────────────┐   ┌────────────────────────┐
│ GEMINI LIVE │   │ DASHBOARD (reader)     │
│ Charon, v1α │   │   Leaflet, Tailwind,   │
│ + tools     │   │   GSAP                 │
└─────────────┘   └────────────────────────┘
```

- **Brain:** Gemini 3.1 Flash Live (`gemini-3.1-flash-live-preview`, **v1alpha** only)
- **Voice:** Gemini Live native, locked to **Charon**
- **Web grounding:** Gemini's built-in `googleSearch` tool
- **Relay:** Cloudflare Worker as a WebSocket proxy. The browser never sees the API key.
- **Family-dashboard sync:** Cloudflare **Durable Object** pub/sub (free-tier
  `new_sqlite_classes`). Phone writes intent triggers; dashboard reads them.
- **Front end:** Vanilla HTML/JS/CSS. No framework. No build step.
  Tailwind + GSAP + Leaflet via CDN on the dashboard only.
- **Hosting:** Vercel for static frontend; Cloudflare Workers for relay + room.

---

## Why a WebSocket proxy?

The original plan used the `@google/genai` SDK from a CDN, with the API key hardcoded
in the browser. Two problems:

1. **`.gitignore` ≠ "not deployed".** Vercel ships gitignored files — the key would be public.
2. **The SDK doesn't load reliably on iOS Safari** from any CDN we tried.

So the Worker is a thin WS proxy: browser → Worker → Gemini Live. The Worker injects the
API key, the system prompt, the voice config, and the tool declarations server-side.
Cleaner architecture, fewer moving parts, key never leaves the server.

---

## Tools (Gemini Live function calls)

| Tool | Status | What it does |
|---|---|---|
| `enable_camera` | live | Turn on camera + **block until first real frame** is shipped, so Rayyy can't answer before he can see |
| `disable_camera` | live | Turn off camera (15s auto-off as backstop) |
| `get_current_time` | live | Singapore local time |
| `googleSearch` | built-in | Live web grounding for weather, hawker hours, MRT, news |
| `identify_person_in_front` | stub (honest) | Returns `{recognized: false}` — Rayyy describes generically and **never fabricates a name** |
| `set_voice_provider` | stub (honest) | Returns `{ok: false, message: "voice_switching_not_implemented_yet"}` — Rayyy tells the user the truth instead of faking the switch |

**Honest stubs are deliberate.** If the model thinks a switch succeeded but the audience
hears the same Charon voice, the demo collapses. Returning `{ok: false}` lets Rayyy say
*"Sorry Auntie Mei, I can't switch voices yet — coming soon"* — and the audience hears
the system being honest about its limits.

---

## Privacy invariant

The voice agent runs on Auntie Mei's body. The dashboard projects on a stage.
The boundary between them is content-free.

**Never sent off-device:**
- Verbatim text of what she said
- Quoted speech in any form
- Output transcription of what Rayyy said

**What the dashboard receives:**
- Intent triggers only — `conversation_start`, `recognition`, `location_query`,
  `voice_switch`, `scene_described`, `honesty_event`, `time_check`, `wellbeing_tick`
- No content. No words.

The dashboard's "Topics today" card is explicit about this. Footer reads
*"Connected, not watched."*

---

## Repo layout

```
rayyy/
├── CLAUDE.md                  ← project context (source of truth)
├── BUILD-PLAYBOOK.md          ← retrospective: every pivot, every bug, every fix
├── README.md                  ← this file
├── system-prompt.md           ← mirror of worker SYSTEM_INSTRUCTION
├── wrangler.toml              ← Worker + Durable Object config
├── vercel.json                ← static hosting + headers
├── worker/
│   └── index.js               ← /ws proxy + AuntieMeiRoom DO
└── public/
    ├── index.html             ← phone UI
    ├── app.js                 ← phone client (mic, camera, tool dispatch)
    ├── styles.css             ← phone styles
    └── dashboard.html         ← family dashboard (self-contained)
```

---

## Run it locally

You need: Node 20+, a Gemini API key with Live API access, a Cloudflare account.

```bash
# 1. Install deps for wrangler / vercel CLIs
npm install -g wrangler vercel

# 2. Local Worker (uses .dev.vars for GEMINI_API_KEY)
echo "GEMINI_API_KEY=AIza..." > .dev.vars
wrangler dev

# 3. Open public/index.html via any static server, pointing the relay at localhost
#    e.g. http://localhost:3000/?relay=http://localhost:8787
```

Deploy:

```bash
# Worker
echo "AIza..." | wrangler secret put GEMINI_API_KEY
wrangler deploy

# Frontend
vercel deploy --prod
```

---

## Hardware (demo)

- iPhone running the web app, chest-strapped
- Apple EarPods USB-C — mic input + tap-to-toggle inline button
- Bluetooth speaker → projector (dashboard side)

The phone listens for spacebar / `MediaPlayPause` (the EarPods inline button) to toggle
Talk. iOS Safari sometimes intercepts `MediaPlayPause`; the on-screen Talk button covers
that case. Audio routing fix: output goes through `MediaStreamDestination → <audio>`,
not `AudioContext.destination` — the latter loses the loudspeaker on iOS the moment the
camera turns on.

---

## What's *not* in here

- Auth, accounts, login
- A persistent database (memory is hardcoded into the system prompt for the demo;
  v2 would use Cloudflare D1)
- Native mobile app (it's a mobile web app)
- Real face matching (the `identify_person_in_front` tool is a stub)
- Real ElevenLabs voice swap (the `set_voice_provider` tool is a stub)
- Health-data integrations (the dashboard's Health Snapshot is mocked)

The product *pitches* these. The dashboard *implies* them. Judges fill in the gaps when
the rest is solid.

---

## Credits

Built solo by **Freddy** for the AI Engineer Singapore hackathon, with pair-programming
help from Claude (Opus 4.7).

The full retrospective — every pivot, every bug, every iOS Safari audio-routing
whack-a-mole moment — lives in [`BUILD-PLAYBOOK.md`](./BUILD-PLAYBOOK.md).
