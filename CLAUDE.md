# Rayyy.ai — Project Context

You are pair-programming with Freddy on **Rayyy.ai**, his entry to the AI Engineer Singapore hackathon. Originally a 7-hour solo build. Targeting Gemini Best Voice Agent track and Overall.

> This file was rewritten on 2026-05-09 after a full test build. It now reflects what was actually shipped, the architecture that emerged, and every hard-won gotcha. The historical "what we planned to build" lives in `BUILD-PLAYBOOK.md`.

---

## What we built

A multilingual voice + vision AI companion for elderly visually impaired people, **plus** a real-time family dashboard that lets a sighted family member follow along.

**Two artifacts, one system:**

| Surface | Who it's for | What it does |
|---|---|---|
| **The phone** (`/`) | Auntie Mei (the user) | Voice agent. Camera. Mic. Output through speaker / Bluetooth / earbuds. UI is minimal — she's blind. |
| **The dashboard** (`/dashboard.html`) | Ah-Hua (her daughter) — and the demo audience | Live visualization of mum's day. Reacts in real time to events from the phone. Projector-friendly. |

**Core principle: Rayyy is a real voice agent, not a scripted demo.** Freddy will have an unscripted conversation with it on stage. Every interaction must work fluidly — any phrasing, any order, any language. The system handles intent, not exact words.

**Avatar:** Auntie Mei, 72, Singaporean, lives alone in **Toa Payoh**. Mandarin at home, Singlish-mixed-English at the kopitiam, understands Hokkien. Lost sight five years ago to diabetic retinopathy.

**Demo context:** Auntie Mei is at the AI Engineer Singapore venue (Acacia College, 20 College Ave E). She's surrounded by strangers, can't see them, and uses Rayyy to navigate.

---

## Stack (current, locked)

- **Brain:** Gemini 3.1 Flash Live (`gemini-3.1-flash-live-preview`, **v1alpha endpoint only**)
- **Voice:** Gemini Live native, locked to **Charon** (warm male). ElevenLabs swap declared as a tool stub for future Phase 6.
- **Web grounding:** Gemini's built-in `googleSearch` tool (live web facts when needed)
- **Relay:** Cloudflare Worker as a **WebSocket proxy** — phone connects to Worker, Worker proxies to Gemini, injects API key + system prompt + voice config + tools. Browser never sees the key.
- **Family-dashboard sync:** Cloudflare **Durable Object** as a pub/sub room. Phone writes events; dashboard reads them. SQLite-backed (free tier compatible).
- **Front end:** Vanilla HTML/JS/CSS. No framework. No build step. Tailwind + GSAP + Leaflet via CDN on the dashboard only.
- **Hosting:** Vercel for static frontend. Cloudflare Workers for the relay + room.
- ~~**Ambient bed (Lyria RealTime)**~~ — *dropped from scope.*

---

## Architecture

```
┌───────────────────────────────────────────────┐
│ PHONE — rayyy-smoketest.vercel.app            │
│ (Auntie Mei, blind user, chest-strapped)      │
└───────┬───────────────────────────────┬───────┘
        │ Gemini Live WS                │ Room WS (writer)
        ▼                               ▼
┌───────────────────────────────────────────────┐
│ CLOUDFLARE WORKER — rayyy-relay.fred-53e      │
│  /ws            → Gemini Live proxy           │
│    (injects key, system prompt, voice, tools) │
│  /ws/auntie-mei → AuntieMeiRoom (Durable Obj) │
│  /health        → live config readout         │
└───────┬───────────────────────────────┬───────┘
        │ wss + key                     │ broadcasts to readers
        ▼                               ▼
┌─────────────────────┐   ┌────────────────────────────────┐
│ GEMINI LIVE         │   │ DASHBOARD — /dashboard.html    │
│ v1alpha             │   │ (Ah-Hua / projector audience)  │
│ Charon · audio +    │   │ Subscribes to room events      │
│ vision + tools      │   │ Animates in real time          │
└─────────────────────┘   └────────────────────────────────┘
```

Both phone and dashboard are static pages on the same Vercel deployment. The Worker holds the only secrets.

---

## What we are NOT building

- Auth / login / accounts
- Database / persistence (D1 is v2 — see "Memory" below)
- Native mobile app (it's a mobile web app)
- Telephony — calls, SMS, voice notes (the dashboard buttons are stubs that look real)
- Real face-recognition matching (Phase 7 stub returns `{recognized: false}`)
- Real ElevenLabs voice swap (Phase 6 stub returns `{ok: false, message: 'not implemented'}`)
- Health-data integrations (the Health Snapshot card is hardcoded mock data)
- Real care-notes CRUD (the Notes button is visual)
- Lyria RealTime ambient bed (dropped)

The product *pitches* these. The demo *implies* them via the dashboard. Judges fill in the gaps when the rest is solid.

---

## Memory and persistence

**For the real product (post-hackathon):** persistent memory matters deeply. v2 will use Cloudflare D1 for facts, notes, contacts, conversation history.

**For the hackathon demo:** Auntie Mei's facts are hardcoded directly into the system prompt. The AI behaves as if it has remembered everything about her — because it does, from the prompt. The audience cannot tell the difference during a 2:30 demo.

---

## Hardcoded context (the memory layer for the demo)

Build these directly into the system prompt:

**Auntie Mei's facts** (use naturally, never recite):
- 72 years old, Chinese-Singaporean, lives alone in **Toa Payoh**
- Lost her sight five years ago to diabetic retinopathy
- Daughter is **Ah-Hua**, lives in Punggol, calls every Saturday morning
- Diabetic, no peanuts, sugar-limited diet
- Husband Mr. Tan passed in 2019. Don't bring him up unless she does.
- Favorite hawker dish: Frog Porridge in Geylang
- Goes to wet market every Tuesday and Friday morning

**Today's situation** (Saturday May 16, 2026):
- At **AI Engineer Singapore** conference, Acacia College, 20 College Ave E
- Many strangers around
- Friend **Kimberly** is here today
- Doctor's appointment with **Dr. Tan at NUH at 4pm**
- Warm afternoon

> **Resolved inconsistency:** earlier drafts wrote "Bedok" in one section and "Toa Payoh" in another. The locked answer is **Toa Payoh**. The dashboard map and all UI text uses Toa Payoh.

---

## Voice character — Rayyy

Patient. Warm. Slightly familial. Calls user "Auntie Mei" naturally. Uses Singlish particles (lah, leh, ah, can, got) when she does. Switches to Mandarin instantly when she does. Never condescends. Never explains itself unnecessarily. Replies brief — under 12 seconds spoken length. Affection cues: *"Auntie Mei, today the fish quite fresh ah"* not *"the fish appears to be fresh."*

**Voice provider:** Gemini Live · **Charon** (locked at session setup via `speechConfig.voiceConfig.prebuiltVoiceConfig`). The model can change *style* mid-session (more formal, less Singlish, slower) but cannot change *voice character* — that requires a real provider swap (Phase 6).

**Honesty principle:** Rayyy never invents information. If it doesn't recognize a person, it says so plainly. If it can't see clearly, it asks Auntie Mei to reposition. If a tool returns "not implemented" (e.g. voice switch), it tells her honestly — never fakes it.

**Currency lesson:** the system prompt explicitly does NOT read Singapore currency notes. Singapore notes have distinct sizes; blind users feel them. Reading them aloud is a sighted-person assumption that misses how blind people actually work with money. *(This was a real correction made during testing.)*

---

## System prompt structure (behavioral, not example-based)

The full prompt lives in two places, kept in sync:
- `worker/index.js` → `SYSTEM_INSTRUCTION` (source of truth, sent to Gemini)
- `system-prompt.md` (mirror, for human review)

It teaches Rayyy *how to behave* across categories of intent, NOT how to match specific phrases. The current structure has 7 CORE BEHAVIORS:

```
1. IDENTITY questions → enable_camera + identify_person_in_front
                        → name if matched, generic if not, NEVER fabricate
2. LOCATION questions → reference today's situation directly
3. OBJECT/SCENE questions → enable_camera, wait for frame, describe
                            → do NOT read SG currency
4. TIME questions → get_current_time, conversational reply
5. FACTUAL/CURRENT questions → google_search grounding
6. VOICE SWITCH commands → set_voice_provider once, apologise if not impl
7. CASUAL CONVERSATION → match register, reference what you know
```

Plus four cross-cutting principles: LANGUAGE matching, STYLE adjustability, HONESTY, PACE.

---

## Tools (Gemini Live function calls)

Locked into the setup message. The model decides when to call them.

| Tool | Status | Purpose |
|---|---|---|
| `enable_camera` | ✅ live | Turn on camera before answering anything visual. Blocks until first frame is sent so Rayyy doesn't hallucinate. |
| `disable_camera` | ✅ live | Turn off camera when visual task is done (saves battery). 15-second auto-off as a backstop. |
| `identify_person_in_front` | 🟡 stub | Returns `{recognized: false}` until Phase 7 wires real face matching against Kimberly photos. |
| `set_voice_provider` | 🟡 stub | Returns `{ok: false, message: '...not implemented...'}` until Phase 6 wires ElevenLabs. Rayyy explicitly tells Auntie Mei it can't switch yet. |
| `get_current_time` | ✅ live | Returns Singapore local time. Use when asked. |
| `googleSearch` (built-in) | ✅ live | Live web grounding for weather, hawker hours, MRT, news, prices. |

---

## Privacy stance (non-negotiable)

The voice agent runs on Auntie Mei's body. The dashboard projects on a stage. The boundary between them must be content-free.

**On the device only:**
- Audio sent to Gemini (unavoidable for a voice agent)
- Input transcription used **locally** for intent matching (e.g. detecting "where am I")

**Never sent to the dashboard, the room, or any storage:**
- Verbatim text of what she said
- Quoted speech in any form
- Output transcription of what Rayyy said

**What the dashboard receives:**
- Intent triggers only — `conversation_start`, `recognition`, `location_query`, `voice_switch`, `scene_described`, `honesty_event`, `time_check`, `wellbeing_tick`
- No content. No words. The dashboard's "Topics today" card is explicit about this.

**Why it matters:** projecting a blind elderly woman's verbatim speech on a venue screen for an audience to read is not okay. We had this card built ("Recent words") and removed it deliberately.

**Cost protection:** a hard **billing cap on the Gemini API** is set on Freddy's Google AI Studio account. Even if the Worker / CORS allowlist / rate limiting all fail, worst-case loss is bounded.

---

## Demo behavior (NOT a script)

Freddy walks on stage with the phone strapped to his chest, closes his eyes, and has a real conversation with Rayyy as Auntie Mei. The dashboard is on the projector behind him, updating live as the conversation unfolds. He won't memorize lines.

**Beats to land** (in any order, any phrasing):

1. **Greeting** — Rayyy responds warmly to a casual hello in any language
2. **Location awareness** — when asked where they are, references the venue + crowd context. Dashboard's map pin pulses + caption updates.
3. **Vision moment** — describes objects, describes the scene, reads text when the camera is aimed and asked. Dashboard's `scenes` chip lights up.
4. **Face recognition** — recognizes Kimberly when she's in front of the camera (Phase 7); describes generically and honestly when seeing strangers (current default). Dashboard's `faces` chip lights up.
5. **Voice switch** — when asked to switch, currently apologises politely (Phase 6 will make it real). Dashboard logs the voice-tweak intent.
6. **Time awareness** — what time is it / when's my doctor → fires `get_current_time` or references the prompt. Dashboard's `time` chip lights up.
7. **Closing** — warm acknowledgement when Auntie Mei thanks Rayyy.

These are *capabilities*, not lines. Build the system so they all work fluidly to whatever Freddy actually says in the moment.

---

## Hardware (locked)

- Phone running web app (chest-strapped)
- Apple EarPods USB-C — mic input + tap-to-toggle inline button
- Bluetooth speaker — selected as audio output (also: laptop driving the projector for dashboard)
- Power bank, USB-C-to-HDMI adapter

The app listens for `MediaPlayPause` keyboard event (sent by EarPods inline button). Spacebar fallback always available. iOS Safari sometimes intercepts `MediaPlayPause` — the audio routing fix and on-screen Talk button cover that case.

---

## Design tokens

Phone is dev-test minimal (dark background, two buttons, viewfinder). Dashboard is the polished surface.

**Phone:**
```
--bg:        #0A0A0A
--fg:        #F5E6D3
--accent:    #FF6B35  (warm orange)
font: Inter
```

**Dashboard (light, warm Singaporean palette):**
```
--bg:        #FAF5EC  (warm cream)
--ink:       #1A1308  (deep warm brown-black)
--ink-muted: #7A6A55
--warm:      #FF6B35  + soft #FFE8DC + deep #D14E1F
--sky:       #4A8FBE  + soft #DCEEFA + deep #2E6F9C
--mint:      #2EAA6E  + soft #DEF5E5 + deep #1F8055
--amber:     #E0A92F  + soft #FFEDC4 + deep #B6831F
--paper:     #FFFCF6
--edge:      #EAE2D2
fonts: Fraunces (display serif), Inter (UI), JetBrains Mono (small caps)
```

Animations: cubic-bezier(0.4, 0, 0.2, 1). Soft pulses (2s+), staggered reveals on load, sparkline draws-in via stroke-dashoffset. `prefers-reduced-motion` disables infinite loops.

---

## Latency philosophy

We embrace it. The Voice tag on the dashboard or phone shows: *"Voice: Gemini Live · ~280ms"*. The lag is proof of how much is happening, not a failure mode. Camera vision answers feel ~700ms because we deliberately hold the tool response until the first frame is delivered — better than a hallucinated reply.

---

## File structure (current)

```
rayyy/
├── CLAUDE.md                  ← this file (source of truth)
├── BUILD-PLAYBOOK.md          ← chronological retrospective + bug catalog
├── README.md
├── system-prompt.md           ← mirror of worker/index.js → SYSTEM_INSTRUCTION
├── .env.local                 ← API keys, gitignored
├── .dev.vars                  ← wrangler local secrets, gitignored
├── .gitignore
├── wrangler.toml              ← Worker + Durable Object config
├── worker/
│   └── index.js               ← Gemini WS proxy + AuntieMeiRoom DO
├── public/
│   ├── index.html             ← phone UI
│   ├── app.js                 ← phone client logic
│   ├── styles.css             ← phone styles
│   ├── dashboard.html         ← family dashboard (self-contained)
│   └── assets/
│       ├── auntie-mei-square.jpg  (optional; falls back to 梅 character)
│       ├── map-toa-payoh.png      (optional; falls back to Leaflet)
│       ├── kimberly-1.jpg         (Phase 7 will add these)
│       ├── kimberly-2.jpg
│       └── kimberly-3.jpg
└── .vercel/                   ← Vercel project link (gitignored)
```

---

## Hard rules for Claude Code

1. **Never add a framework.** Vanilla JS only. Tailwind/GSAP/Leaflet via CDN on the dashboard are exceptions because they don't need a build step.
2. **Never add a build step.** No webpack, vite, esbuild. Wrangler bundling for the Worker is fine.
3. **Never add a database** for the demo. Memory is hardcoded in the system prompt. Real persistence is v2 (Cloudflare D1).
4. **Never expose the Gemini API key to the browser.** Worker is the only place it lives. Even gitignored `public/config.js` deploys to Vercel — that path was rejected.
5. **Never forward Auntie Mei's verbatim speech to the dashboard or any storage.** Intent triggers only.
6. **Build the system prompt behaviorally**, not by example-matching. Rayyy must handle any phrasing of an intent.
7. **The system must work without a script.** Test by asking the same intent in 3 different phrasings — all should work.
8. **When a tool isn't built yet, return an honest "not implemented" response** so Rayyy tells the user the truth instead of faking it.
9. **When stuck, the escape hatch is hardcoded mock data.** Demo > production.
10. **The CLAUDE.md is the source of truth.** If any choice in code conflicts with this file, this file wins.

---

## Known traps + fixes (the hard-won list)

These cost real time during the build. Future-Freddy and future-Claude should know about them.

### Cloudflare / Worker

- **Workers.dev subdomain is a one-time blocker.** A fresh Cloudflare account has no subdomain. `wrangler deploy` fails with code 10097 until you register one (dashboard onboarding, ~30 sec). The MCP can do this via the API too.
- **Free-plan Durable Objects need `new_sqlite_classes`, not `new_classes`** in the migration. Otherwise the deploy errors with code 10097.
- **Outbound WebSocket from a Worker uses `https://` URL + `Upgrade: websocket` header**, then `resp.webSocket.accept()`. Don't use `wss://` for the upstream URL.
- **Gemini Live frames arrive as `Blob` in Cloudflare Workers**, not `ArrayBuffer` or `Uint8Array`. Decode with `await blob.text()` for JSON, then forward to the browser as a string. (We initially logged `<binary>` and assumed wrong types.)
- **CORS allowlist must include the exact production Vercel URL.** Use the stable alias (e.g. `rayyy-smoketest.vercel.app`), not the per-deploy hash URL. Otherwise readers/writers from the public origin are rejected.

### Gemini Live API

- **Model `gemini-3.1-flash-live-preview` is on `v1alpha` only**, not `v1beta`. Connecting to v1beta gives a 1008 close with "model not found for API version".
- **`speechConfig` lives inside `generationConfig`**, not at the top level of `setup`. Putting it on `setup` directly returns a 1007 close with "Unknown name speechConfig".
- **Model decides when to call tools.** For vision, the model can fire `enable_camera` then immediately respond — *before* a frame has been sent. The fix: make the tool handler `await` the first frame send before returning the toolResponse. Without this, first-attempt accuracy is bad ("Why is it answering wrong things?").

### iOS Safari audio

- **`getUserMedia({video})` flips the OS audio session into "play-and-record" mode**, which routes output to the earpiece (not the loudspeaker). This is the #1 reason audio "broke" repeatedly during the build.
- **Permanent fix:** route `AudioContext` output through a `MediaStreamDestination` → `<audio>` element. The `<audio>` element uses iOS's media-playback path, which preserves speaker routing across audio session changes. Connecting straight to `AudioContext.destination` fights iOS and loses.
- **Earbuds bypass the issue entirely.** Demo hardware has them, so production is fine. Patches are best-effort for the no-earbuds case.
- **Pre-resample to `outCtx.sampleRate` on the JS side.** iOS Safari often ignores `new AudioContext({sampleRate: 24000})` and gives 44.1k or 48k. Auto-resampling by Web Audio glitches when the AudioContext gets interrupted, causing pitch shifts. Linear resample in JS to match the actual rate.
- **Reset `nextStartTime = outCtx.currentTime` after AudioContext resume.** Otherwise the playback queue's scheduled time is stale and audio plays at wrong offset.
- **Block stacked sessions.** Tapping Talk while a previous WebSocket is still connecting opens a second session. Both feed audio into the same destination → user hears two Charons overlapping. Fix: in `toggleTalk`, ignore the press if `ws.readyState === CONNECTING`.

### CDN / SDK loading on iOS

- **`@google/genai` SDK doesn't load reliably on iOS Safari** via dynamic `import()` from any CDN we tried (esm.sh 404, jsdelivr loaded but failed during sub-import resolution). The fix is to skip the SDK entirely and use raw WebSocket. The Worker proxy makes this easy because the wire protocol is just JSON over WS.

### iOS camera + viewfinder

- **Off-DOM `<video>` element painted to a `<canvas>` viewfinder reduces (doesn't eliminate) iOS audio-session interference** vs an in-DOM `<video>` displaying the stream directly. Worth doing.
- **Camera turn-on needs a brief autofocus pause before the first frame goes out.** 800ms feels right. Combined with the "block tool response until first frame is sent," vision answers are accurate on first try.

### Vercel deploys

- **Gitignored files in `public/` still deploy to Vercel.** A `public/config.js` containing a key — even with the file in `.gitignore` — gets served publicly. The `.gitignore` only governs git, not Vercel. The Worker secret approach is the only safe path.
- **Vercel Deployment Protection is on by default for new projects.** New preview URLs are behind a login wall. To make the submission link public, disable it in project settings *or* push to production with `vercel deploy --prod`.

### Voice / TTS

- **Voice character is locked at session setup.** Telling Rayyy "change your voice" mid-session does nothing — he can only change *style*. Telling him this in the system prompt prevents him from faking compliance.

### Lyria

- **Dropped from scope.** It looked like a third-place feature that ate disproportionate time. Gen Media track wasn't worth the risk to the headline beats.

---

## What "real" means in the deployed system

When demoing, be honest with yourself about what's live vs decorative:

**Live (reacts to phone events):**
- Hero status pill, hero stat counters
- Recent moments slide-in
- Map pin pulse + location caption flip
- Wellbeing sparkline nudge
- Activity-pattern current-hour bar growth
- Topics chip cluster (lights up by intent)
- Connection chip / last-sync ticker
- Clock + greeting

**Decorative / hardcoded:**
- Days connected (247)
- Today's rhythm timeline
- Health snapshot (blood sugar, hydration, steps, sleep)
- Her circle (Ah-Hua, Kimberly, Dr Tan, Mr Lim)
- Emergency contact phone numbers
- "Voice call Auntie Mei" button (doesn't actually call)
- Tonight's reminder (metformin)

For a stage demo this mix sells the vision. For a product, the decorative half becomes the v2 backlog.
