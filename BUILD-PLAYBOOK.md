# RAYYY.AI — BUILD PLAYBOOK (Retrospective Edition)

> Originally a forward-looking 8-phase plan. Rewritten on 2026-05-09 after a full test build, this version is a **retrospective**: what actually happened in each phase, what bugs cost real time, what decisions changed the direction, and what a clean rebuild should do differently.
>
> Companion file: `CLAUDE.md` (the source-of-truth project context). This file is the journey.

---

## Final state at a glance

| Surface | URL | Source |
|---|---|---|
| Phone (Auntie Mei's voice agent) | `https://rayyy-smoketest.vercel.app/` | `public/index.html` + `public/app.js` |
| Family dashboard | `https://rayyy-smoketest.vercel.app/dashboard.html` | `public/dashboard.html` (self-contained) |
| Dashboard demo / projector backup | `…/dashboard.html?fake=true` | scripted timeline in same file |
| Cloudflare Worker (relay + DO room) | `https://rayyy-relay.fred-53e.workers.dev/` | `worker/index.js` |
| Worker health | `…/health` | returns `{ok, model, voice}` |

Architecture summary lives in `CLAUDE.md`. Read that first if you're picking this up cold.

---

## Phase status (as built)

| # | Phase | Status |
|---|---|---|
| 1 | Scaffold | ✅ done |
| 2 | Voice loop (Gemini Live via Worker WS proxy) | ✅ done |
| 3 | Camera + vision (voice-activated, on-demand) | ✅ done |
| 4 | System prompt + persona + tool stubs | ✅ done |
| 5 | **Family dashboard with Cloudflare Durable Object live sync** | ✅ done *(reframed from "design layer")* |
| 6 | ~~Lyria~~ | ❌ **dropped from scope** |
| 7 | ElevenLabs voice switch | 🟡 stub only — tool declared, returns "not implemented" |
| 8 | Kimberly face matching | 🟡 stub only — tool declared, returns "not recognized" |
| Polish | Latency badge, pulse, glow, dashboard polish | ✅ included throughout phases |

The build succeeded its main goal: a real, unscripted voice-and-vision agent with a live-syncing family dashboard. The two stubs are intentional — they let Rayyy *know about* the capability and tell the user honestly that it's not there yet.

---

## Phase 1 — SCAFFOLD

**What was planned:** create `wrangler.toml`, `worker/index.js`, `public/index.html`, `public/app.js`, `public/styles.css`, `public/assets/`, `system-prompt.md`, `README.md`.

**What we actually did:**
- Skipped `wrangler.toml` and `worker/` initially (planned to hardcode keys for speed).
- Created phone-side scaffold with permission-grant flow.
- Deployed to Vercel via `npx vercel deploy`.

**Hiccups:**
- `vercel` CLI wasn't installed globally. Fixed with `npm install -g vercel`. The `~/.npm-global/bin` directory wasn't on PATH; appended `export PATH="$HOME/.npm-global/bin:$PATH"` to `~/.zshrc`.
- First Vercel preview URL was behind Deployment Protection (login wall). Disabled later via the Vercel dashboard so the submission link is public.

**Lesson:** Vercel preview deploys are *not public by default* for new projects. To submit a public link, either disable Deployment Protection or push to production (`--prod`).

---

## Phase 2 — VOICE LOOP (the long one)

**Goal:** press Talk, say "hello hello", hear Rayyy reply.

**Original plan:** use the `@google/genai` SDK from a CDN to talk to Gemini Live directly from the browser. Hardcode the API key.

**What actually happened — sequence of pivots:**

1. **Hardcoded key in `public/config.js`** (gitignored). Worked locally.
2. Realised `.gitignore` ≠ "not deployed". Vercel ships gitignored files. The key would be public.
3. Pivoted to a **Cloudflare Worker token relay** that mints ephemeral Gemini auth tokens. Cloudflare Workers MCP used to register the workers.dev subdomain (`fred-53e`) since `wrangler deploy` failed otherwise (error 10097).
4. The ephemeral-token API rejected our setup payload shape. After several iterations on the JSON body…
5. Pivoted again to a **WebSocket proxy** Worker. Browser opens WS to Worker; Worker opens WS to Gemini and pipes between them, injecting the API key. Cleaner than ephemeral tokens — and avoids the SDK entirely (which never loaded reliably on iOS Safari).
6. **Model not found** errors: tried `gemini-2.0-flash-live-001` on v1beta, got 1008 close. Listed models via REST, found `gemini-3.1-flash-live-preview` is on **v1alpha only**. Updated upstream URL.
7. **Setup message rejected** with 1007 "Unknown name speechConfig at setup". Moved `speechConfig` from top-level into `generationConfig`. Worked.
8. **Gemini's response frames came in as `Blob`** in Cloudflare Workers (not `ArrayBuffer` or `Uint8Array`). Initial logs showed `<binary>` and `[unk]` until we wrote a decoder for all three types. Once decoded, JSON `setupComplete` flowed and audio worked.
9. **Voice locked to Charon** via `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. Verified by adding `voice` to the `/health` endpoint and showing it in the phone UI.

**Audio output bugs (recurring):**
- iOS Safari with camera active routes `AudioContext.destination` through the earpiece. Final fix: route output through a `MediaStreamDestination` → `<audio>` element (which uses iOS media-playback routing). Multiple intermediate patches (`latencyHint: 'playback'`, statechange resumes) helped but weren't sufficient alone.
- Sample-rate mismatch (iOS often ignores `sampleRate: 24000`, hands you 44.1 or 48k) caused pitch shifts on session interruption. Fixed with linear pre-resample in JS.
- Stacked sessions when tapping Talk during connect caused two Charons overlapping ("voice changing high and low randomly"). Fixed with `isConnecting()` guard + `teardownWs()` on each open.

**Lesson:** the WebSocket proxy is a better default than the SDK for this kind of project. It removes one whole layer of "did the CDN work today?" and gives the Worker control over what gets injected (model, system prompt, voice, tools — all server-side).

---

## Phase 3 — CAMERA + VISION

**Goal:** hold up an object, ask "what is this?", get a description.

**Sequence:**

1. **Always-on 1fps camera** with viewfinder. Worked but caused immediate audio cutoff on iOS without earbuds (the audio routing issue from Phase 2 surfaced here).
2. **On-demand camera with manual "Look" button** + 15-second auto-off backstop. Better.
3. **Voice-activated camera** via Gemini Live tool calls (`enable_camera`, `disable_camera`). The whole point — Auntie Mei is blind, she can't tap a button. Rayyy decides when to look.
4. **First-attempt accuracy was terrible.** User reported "first attempt wrong, second attempt right." Diagnosis: Rayyy was firing `enable_camera`, getting an immediate `ok` response, and generating a vision answer *before any frame had been sent*. He was hallucinating.
5. **Fix: tool handler awaits first frame.** `enable_camera` now blocks until: (a) video element has dimensions, (b) ~800ms autofocus pause, (c) one frame has been encoded and sent over the WebSocket. Only then does the tool response return. Rayyy can no longer answer before he can see.
6. **Off-DOM video → canvas viewfinder.** The `<video>` element interferes with iOS audio routing even when muted. Replaced with: hidden in-JS video drives a visible `<canvas>` painted via `requestAnimationFrame`. Reduces (not eliminates) iOS audio interference.
7. **Currency removed from the prompt.** User correctly flagged: blind users feel SG notes (each denomination is a different size). "Read this S$50" was a sighted-person UX assumption. Replaced with: read text she can't feel — labels, expiry dates, signs, mail, menus.

**Lesson:** for tool-driven vision, *await the first frame* in the tool handler. Otherwise the model will respond before it can see, and your accuracy collapses on the first turn.

---

## Phase 4 — SYSTEM PROMPT (PERSONA)

**Goal:** Rayyy responds correctly to any phrasing of an intent, sounds Singaporean, never invents.

**What we built:**
- Behavioral routing across **7 CORE BEHAVIORS** (identity, location, object/scene, time, factual/search, voice switch, casual)
- Auntie Mei's full context (Toa Payoh, Ah-Hua in Punggol, Mr. Tan, Geylang frog porridge, wet market schedule, diabetes, Saturday at AI Engineer Singapore)
- LANGUAGE rule: match her register, never correct, switch instantly
- HONESTY rule: never invent, ask to reposition, NEVER fabricate names
- PACE rule: under 12 seconds, leave room to think
- STYLE CHANGES rule: she can ask for tone changes (more formal, less Singlish, slower) — voice character is locked, only style adjusts
- Tool stubs: `identify_person_in_front`, `set_voice_provider` (return honest "not implemented")
- Live tools: `enable_camera`, `disable_camera`, `get_current_time`, `googleSearch`

**Hiccup:** CLAUDE.md had Auntie Mei in *Toa Payoh* in one section and *Bedok* in another. Locked to **Toa Payoh** during this phase; CLAUDE.md updated.

**Honest-stub trick:** when `set_voice_provider` returns `{ok: false, message: 'not implemented'}`, Rayyy says *"Sorry Auntie Mei, I can't switch voices yet — coming soon"*. Without that, he'd verbally claim the switch and the audience hears the same Charon voice → user confused. Honest stubs > silent stubs.

**Lesson:** declare tools you haven't implemented yet, and have them return honest errors. The model adapts and tells the user the truth.

---

## Phase 5 — FAMILY DASHBOARD (the reframe)

**Original plan:** Phase 5 was an audience-facing visual layer on the *phone* (full-viewport camera + transcript + state indicator + brand mark). Started building it, then stopped — Auntie Mei is blind, the screen on her phone doesn't matter.

**Reframe:** Phase 5 became the **Family Dashboard** on a *separate page*, watched by Ah-Hua (the daughter persona) and the demo audience via projector. The phone is the device on Auntie Mei's chest; the dashboard is the spectacle.

**Architecture:**
- **Cloudflare Durable Object** (`AuntieMeiRoom`) as a real-time pub/sub room
- Phone connects with `?role=writer&key=…`, dashboard with `?role=reader&key=…`
- DO holds last 20 events + replays on reader join (so a fresh dashboard load gets context)
- Free-tier free tier requires `new_sqlite_classes` migration, not `new_classes` — first deploy failed until we fixed that

**Events emitted by the phone:**
- `conversation_start` — every `openSession`
- `recognition` — when `identify_person_in_front` fires (with `{who, confidence}`)
- `honesty_event` — alongside no-recognition stub
- `voice_switch` — when `set_voice_provider` fires
- `scene_described` — on `turnComplete` if camera active (throttled to 5s)
- `location_query` — when input transcription matches "where am I" patterns *(text-matched locally; the phrase itself is not transmitted)*
- `time_check` — when `get_current_time` fires
- `wellbeing_tick` — every 30s while connected (idle heartbeat)

**Dashboard versions, in order:**
1. **Dark phone-frame** (430px max-width). Looked OK but felt like an app preview, not a stage artifact.
2. **Light + colorful, full-screen.** Warm cream background, color-coded cards (peach hero, sky map, mint wellbeing, amber reminders).
3. **Polished commercial-grade pass.** Added: real Leaflet map of Toa Payoh (warm-tinted CartoDB tiles), Fraunces serif for display, GSAP staggered reveals, breathing portrait, double pulse rings, animated stat counters, sparkline draws-in, hover lift on cards, time-aware greeting, connection chip, multi-layer soft shadows.
4. **Density pass.** Added Today's rhythm (timeline), Health snapshot (mocked diabetes-aware), Her circle (people chips), Voice & language, Topics today, At-a-glance numbers, Activity pattern (24h bars), Care notes, Reach Mum action card, Emergency contacts.
5. **Privacy-driven replacement.** "Recent words" with hardcoded quoted speech was rejected by the user — projecting verbatim transcription on a venue screen is not okay. Replaced with **Topics today**: content-free chip cluster derived from intent triggers only. *Each chip lights up + counts up as events fire. No words.*
6. **Single-viewport packing attempted, reverted.** Trying to clamp the layout to `100dvh` made cards overflow their rows and visually stack. Reverted to natural flow with compaction (smaller paddings, dropped 3 cards: Care notes, Voice & language, At-a-glance). Looks great, scrolls if viewport is short.

**Final dashboard cards (top to bottom):**

```
[Header: rayyy · greeting · clock · live/demo chip]
[Hero: portrait + name + 3 animated stat counters + status pill]
Row 1:  Where she is (Leaflet map)  |  Recent moments  |  Wellbeing + Tonight
Row 2:  Today's rhythm  |  Health snapshot  |  Her circle
Row 3:  Topics today  |  Activity pattern (24h)  |  Reach Mum + Emergency
[Footer: braille R-A-Y-Y-Y · "Connected, not watched." · last sync]
```

**Bulletproof projector mode (`?fake=true`):** runs a 32-second scripted timeline ignoring the WebSocket. If venue Wi-Fi dies during the demo, this URL still gives judges the full visual story.

**Live-sync proof points** (real, not mocked):
- Hero status pill, hero stat counters
- Recent moments slide-in (per event)
- Map pin extra pulse + caption swap on `location_query`
- Wellbeing sparkline nudges on `conversation_start` / `wellbeing_tick`
- Activity 24h bar grows on the current hour's bar with each `conversation_start`
- Topics chip cluster lights up + counts per intent
- Connection chip + last-sync ticker
- Clock + greeting tick from real time

**Decorative (mocked, looks real):** Days connected, Today's rhythm, Health snapshot, Her circle, Emergency phone numbers, "Voice call Mum" button, Tonight's metformin reminder.

**The 梅 portrait glitch:** the original `onerror` handler appended HTML to the parent on each failed load → could re-inject indefinitely. Fixed with a layered approach: `<span>梅</span>` always rendered behind, `<img>` absolutely positioned over it; on error the `<img>` hides cleanly and the `<span>` shows through.

---

## Phase 6 — LYRIA (DROPPED)

The plan was a parallel WebSocket to Lyria RealTime for ambient mood-driven music, mixed at -18dB.

**Why dropped:** judging tracks the build is targeting (Best Voice Agent, Overall) don't depend on Gen Media. Lyria was a stretch prize. Once Phase 5 expanded into the Family Dashboard, the time budget was reallocated. Removed from CLAUDE.md, README.md, and this playbook. No code references existed.

---

## Phase 7 — ELEVENLABS VOICE SWITCH (stub only)

**Status:** declared as a tool, returns `{ok: false, error: 'voice_switching_not_implemented_yet'}` so Rayyy tells the user the truth.

**To wire for real:** the architecture is ready. Worker proxies the conversation; you'd need to (a) detect the `set_voice_provider` tool call client-side, (b) flip a `currentProvider` flag, (c) when `elevenlabs`, route Rayyy's text response to ElevenLabs Flash v2 instead of letting Gemini synthesize audio, (d) update `/health` to reflect active provider, (e) the dashboard's voice tag flashes on switch.

To do this properly the Worker would also need to know not to inject `responseModalities: ['AUDIO']` when ElevenLabs is active — instead request TEXT, which the client then sends to ElevenLabs.

---

## Phase 8 — KIMBERLY FACE MATCHING (stub only)

**Status:** declared as a tool, returns `{recognized: false, reason: 'no recognition data loaded yet'}`. Rayyy then describes generically from the camera frame.

**To wire for real:** drop 3 reference photos in `public/assets/` (`kimberly-1.jpg`, etc), use a face-embedding model on the client (TensorFlow.js Face API or similar), compute the cosine similarity between the current frame's face embedding and the reference set. Threshold-gate the match. Tool returns `{recognized: true, name: 'Kimberly', confidence}` if above threshold.

A simpler hackathon hack: detect *that* there's a face in frame (any face) and toggle a "Kimberly mode" via voice command — Freddy orchestrates the moment by asking Rayyy "is Kimberly here?" only when Kimberly stands in front.

---

## DECISIONS LOG

Major direction-changes during the build, in order:

| When | Decision | Why |
|---|---|---|
| Mid-Phase 2 | Skipped @google/genai SDK, used raw WebSocket via Worker | SDK didn't load reliably on iOS Safari from any CDN |
| Mid-Phase 2 | Worker = WebSocket proxy (not ephemeral token relay) | Cleaner architecture, fewer moving parts, key never leaves server |
| Mid-Phase 2 | Voice locked to Charon | Per-session voices were inconsistent; user wanted one stable male voice for Rayyy |
| Mid-Phase 3 | Camera became voice-activated only | Auntie Mei is blind — manual button is wrong UX |
| Mid-Phase 3 | Currency reading removed from system prompt | Blind users identify SG notes by size, not by reading |
| Phase 4 | Tool stubs return honest "not implemented" | Prevents Rayyy from faking compliance |
| Mid-Phase 5 | Original "phone visual UI" abandoned | Auntie Mei doesn't see her phone; the audience does |
| Mid-Phase 5 | Dashboard light + colorful, not dark | User feedback — light feels more product-y, less surveillance-y |
| Mid-Phase 5 | "Recent words" card replaced with "Topics today" | Privacy: never project verbatim speech on a venue screen |
| End of session | Lyria dropped from scope | Stretch prize not worth scope risk |

---

## BUG CATALOG (symptom → cause → fix)

A reference list of every non-trivial bug we hit. If you're rebuilding this and see one of these symptoms, jump to the fix.

### Connectivity / WebSocket

| Symptom | Cause | Fix |
|---|---|---|
| `wrangler deploy` fails with code 10097, "Account already has an associated subdomain" | Cloudflare account has an existing subdomain (`fred-53e`) and `wrangler` thought it didn't | Query `GET /accounts/.../workers/subdomain` to find the existing one, use it |
| `wrangler deploy` errors: "must use new_sqlite_classes" | Free plan requires SQLite-backed Durable Objects | In `wrangler.toml`, change migration from `new_classes` to `new_sqlite_classes` |
| Browser WebSocket closes 1006 immediately | Upstream Gemini WS rejected — usually wrong API version or model | Check Worker logs (`wrangler tail`) for upstream close reason. Use `v1alpha` for `gemini-3.1-flash-live-preview`. |
| Browser WebSocket closes 1008 with "model not found" | Wrong API version path | Use `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent` |
| Browser WebSocket closes 1007 "Unknown name speechConfig at setup" | `speechConfig` placed at top of `setup` instead of inside `generationConfig` | Move it inside `generationConfig` |
| Browser WebSocket closes 1000 (clean) immediately after open | Gemini sent a setup error as a binary frame; client expected text and didn't decode it | Decode `Blob` / `ArrayBuffer` / typed-array frames in the Worker before forwarding |

### Audio output (the long-running fight)

| Symptom | Cause | Fix |
|---|---|---|
| Audio cuts out when camera turns on (no earbuds) | iOS Safari flips audio session to "play-and-record" → routes to earpiece | Route `AudioContext` output through `MediaStreamDestination` → `<audio>` element. Earbuds bypass the issue entirely. |
| Voice "switching tone high and low randomly" | Multiple WebSocket sessions stacked when user tapped Talk during connect | Ignore Talk press if `ws.readyState === CONNECTING`; tear down old WS before opening new one |
| Voice pitch wobbles or shifts mid-sentence | iOS gave AudioContext a different rate than requested → Web Audio auto-resampling glitched on session interrupt | Pre-resample in JS to `outCtx.sampleRate`; reset `nextStartTime = outCtx.currentTime` on resume |
| Audio queue plays old / scheduled-in-past after camera turns on | `nextStartTime` stale after AudioContext suspended/resumed | Reset on `statechange` |

### Vision

| Symptom | Cause | Fix |
|---|---|---|
| First "what is this?" answer is wrong, second is right | Rayyy generating reply before any frame was sent over the WS | Block `enable_camera` tool response until first frame is shipped |
| Camera-on response describes whatever was in frame *before* user aimed | First frame captured too eagerly | Add 800ms autofocus / aim-time pause inside the tool handler |
| Camera-on but viewfinder is black | `<video>` autoplay blocked | Use off-DOM `<video>` painted to `<canvas>` via `requestAnimationFrame` |

### Privacy / scope

| Symptom | Cause | Fix |
|---|---|---|
| Hardcoded API key in `public/config.js` | `.gitignore` only governs git, not Vercel deploys | Move key to Worker secret; never let it touch the browser |
| Initial Vercel preview URL behind login wall | Vercel Deployment Protection is on by default | Disable in project settings, or use `--prod` |
| Real-time transcription ("Recent words") on dashboard | Initial implementation forwarded verbatim speech to the dashboard | Disable transcription forwarding; replace dashboard card with content-free Topics chip cluster |

### UI

| Symptom | Cause | Fix |
|---|---|---|
| 梅 character glitches / repeats on portrait card | `onerror` handler injected HTML into parent on each failed load | Layer the character behind the `<img>` with absolute positioning; hide `<img>` on error instead of replacing parent |
| Dashboard cards visually stack on top of each other when packed to one viewport | `100dvh` clamp + cards taller than allocated row height + no overflow handling | Drop the `100dvh` clamp. Compact via smaller padding + fewer cards, allow scroll on short viewports |

---

## TEST SCRIPTS (for pre-demo verification)

Don't memorize lines. These are *intent variants* — at least 3 of 4 should work for each beat.

### Voice / language

- "Hello hello"
- "你好你好"
- "Eh Rayyy ah, you there or not?"
- "Wah today damn hot leh"

### Identity (with camera)

- "Who is this?"
- "Who's in front of me?"
- "Who am I looking at?"
- "Eh, who's that ah?"

### Location

- "Where are we?"
- "Where am I?"
- "What place is this?"
- "Eh, what is this place ah?"

### Object / scene

- "What is this?"
- "Tell me what I'm holding"
- "Read this for me"
- "What you see ah?"

### Time

- "What time is it?"
- "Is it late ah?"
- "How long until my doctor?"
- "When is Ah-Hua coming?"

### Search-grounded

- "Is the kopitiam in Toa Payoh open?"
- "What's the weather today?"
- "How do I get to NUH?"
- "Eh, news got anything important?"

### Honesty test (must pass)

- Aim camera at empty wall → "Who is this?"
  - ✅ Pass: "I don't see anyone in the frame, Auntie Mei. Can you point the phone at them?"
  - ❌ Fail: any made-up name

### Voice switch (currently apologises)

- "Switch to ElevenLabs"
- "Use the other voice"
- "Change your voice"
  - ✅ Pass: "Sorry Auntie Mei, I can't switch voices yet — coming soon"

### Style change (within session)

- "Be more formal" → next reply should be more formal
- "Speak more Singlish please" → particles return
- "Change back" → reverts

---

## DEPLOY COMMANDS (for the next time)

```bash
# Worker (relay + DO)
export CLOUDFLARE_ACCOUNT_ID=53eda8792a3f322d06f6924764cf7561
export CLOUDFLARE_API_TOKEN=<from .env.local, currently commented out>
wrangler deploy

# Set / rotate the Gemini key
echo "AIza..." | wrangler secret put GEMINI_API_KEY

# Frontend (production)
vercel deploy --prod --yes

# Tail Worker logs (super useful while debugging)
wrangler tail rayyy-relay --format=pretty
```

---

## REBUILD ORDER (if starting clean tomorrow)

1. Cloudflare account: register workers.dev subdomain (one-time, ~30 sec).
2. Worker first: WS proxy at `/ws` → Gemini Live v1alpha. Use `new_sqlite_classes` for the DO.
3. Set `GEMINI_API_KEY` as a Worker secret.
4. Phone HTML/JS: Tap-to-start (mic only, no camera up front), Talk button, raw WebSocket to `/ws`. No SDK.
5. Inject `speechConfig` (Charon) **inside** `generationConfig`.
6. Decode incoming Worker frames as `Blob` first.
7. Output audio: route through `MediaStreamDestination` → `<audio>` element from day one. Don't even try `AudioContext.destination`.
8. Pre-resample to actual `outCtx.sampleRate`.
9. Block stacked sessions in `toggleTalk`.
10. Add tools: `enable_camera`, `disable_camera`, `get_current_time`, `googleSearch`, plus stubs for `identify_person_in_front` and `set_voice_provider` (return honest "not implemented").
11. `enable_camera` tool handler **awaits first frame** before returning. 800ms autofocus pause inside.
12. Camera UI: off-DOM video → canvas viewfinder, 15s auto-off backstop.
13. Write the system prompt with 7 CORE BEHAVIORS, behavioral routing, language matching, honesty, pacing. Mirror to `system-prompt.md`.
14. Durable Object room. Phone emits intent triggers only — never speech text.
15. Dashboard page (separate from phone UI). Cards: hero, map (Leaflet), moments, wellbeing, today's rhythm, health, circle, topics, activity, reach Mum, emergency. Light + colorful palette. `?fake=true` projector backup.
16. Vercel: disable Deployment Protection on the project.
17. Set Gemini billing cap.

That's the whole build. The version that took us through hours of audio-routing whack-a-mole can be done cleanly in a fraction of the time when you skip every cul-de-sac listed above.
