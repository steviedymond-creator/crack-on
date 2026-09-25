# CLAUDE_CRACK_ON.md
## Crack On — Claude Code Build Instructions
## NeoSoulTech Ltd | September 2026
## NST-PC-CO-CD-001 V1.0

---

## WHAT YOU ARE BUILDING

Crack On is a standalone hackathon demo for the Nebius × NVIDIA Global
AI Hackathon. It demonstrates a single, powerful idea: context follows
the person, not the platform. When a user switches from one AI companion
to another, the receiving companion picks up the same thread instantly —
no re-briefing, no context loss, no overhead.

**Tagline: Stop re-briefing. Crack On.**

This is not a complex system. It is a clean, well-executed demo of one
concept done exceptionally well. Every build decision serves the demo
moment: the user switches companion, the new companion continues without
missing a beat.

**Submission deadline: 30 October 2026 — Devpost**

---

## IP BOUNDARY — READ THIS FIRST. NON-NEGOTIABLE.

This is a public repository. The IP boundary must be clean at every
commit.

**NEVER include in any file, comment, or commit:**
- NeoSoulTech or NST naming
- Presence Continuity™ naming
- Any reference to DTAL, CACR, PAT, EAM, HTM, CRWH, VICC
- PC router logic or Supabase schema from the PC spike project
- CCC or Coding Context Capsule
- Presence Key™ as a brand name
- Omega Agent naming

**SAFE to include:**
- Crack On branding only
- Klimt as the anchor companion name
- Context persistence across companion switches
- Re-Briefing Tax elimination as a concept
- Omnipresence framing — context follows the person, not the platform
- Tavily citation and web grounding
- Nebius open-source model
- Auren image generation

If in doubt about whether something belongs in the public repo — it
does not. This rule cannot be overridden.

---

## COMPANION ENSEMBLE

Four companions. Each has a distinct voice via ElevenLabs TTS.
The switching is the demo.

| Companion | Provider / Model | Role | Voice |
|-----------|-----------------|------|-------|
| **Klimt** | Anthropic — claude-sonnet-4-6 | Orchestrating anchor. Always present. Manages context handoff. Returns after every specialist dispatch. | Cevin — `EGvjD0PIKVzXUvyMkwel` |
| **Nebius** | Nebius Token Factory — Qwen/Qwen3-30B-A3B-Instruct-2507 | Open-source compute specialist. Dispatched by Klimt for applicable reasoning tasks. | Steve — `eFsK7V4odsRpqOxGAOc8` |
| **Tavily** | Tavily /search API | Web-grounded specialist. Fires on citation_required or current_events. Returns cited responses. | Maya — `ii0s2u4R3UFnxKL6DOrz` |
| **Auren** | OpenAI — gpt-5.5 | Multimodal specialist. Image generation via DALL-E 3. Distinct creative voice. | Guy — `8ZYhGJrsDOe4C8yzEEhP` |

**Routing logic — simple and explicit:**
- Does the task require web grounding or citations? → Tavily
- Does the task require open-source compute? → Nebius
- Does the task require image generation or visual output? → Auren
- Everything else → Klimt

Routing is keyword-based intent classification only. No PC router
logic. No DTAL. No CACR. Simple, clean, auditable.

Klimt always returns after every specialist dispatch. The user always
has a home.

---

## TECH STACK

| Component | Detail |
|-----------|--------|
| **Frontend** | Plain HTML + CSS + vanilla JS. No framework. Single-page application. |
| **Theme** | Dark. Navy background, cyan accent, yellow-gold highlights, white text. |
| **Context store** | Supabase — dedicated crack-on project. Two tables only. No PC schema. |
| **Companion dispatch** | Direct API calls per companion. Klimt orchestrates. Simple intent classifier. |
| **Voice** | ElevenLabs TTS — distinct voice per companion. Streamed audio per response. |
| **Klimt** | Anthropic SDK — claude-sonnet-4-6. `process.env.ANTHROPIC_API_KEY` |
| **Nebius** | OpenAI-compatible SDK — base URL: `https://api.studio.nebius.com/v1`. `process.env.NEBIUS_API_KEY`. Model: `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| **Tavily** | `@tavily/core` SDK — /search endpoint. basic depth for web_grounded, advanced for citation_required. |
| **Auren** | OpenAI SDK — gpt-5.5. DALL-E 3 for image generation. Rendered inline. |
| **ElevenLabs** | `@elevenlabs/elevenlabs-js` SDK. Voice IDs in env. Streamed audio. |

---

## ENVIRONMENT VARIABLES

All keys are in `.env`. Never commit `.env`. Use `.env.example` as
the reference template.

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
NEBIUS_API_KEY=
ELEVENLABS_API_KEY=
TAVILY_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
ELEVENLABS_VOICE_KLIMT=EGvjD0PIKVzXUvyMkwel
ELEVENLABS_VOICE_NEBIUS=eFsK7V4odsRpqOxGAOc8
ELEVENLABS_VOICE_TAVILY=ii0s2u4R3UFnxKL6DOrz
ELEVENLABS_VOICE_AUREN=8ZYhGJrsDOe4C8yzEEhP
```

---

## DATA MODEL — SUPABASE

Two tables. Minimal schema. No PC architecture exposed.

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  surface TEXT DEFAULT 'web',
  user_id TEXT DEFAULT 'anonymous'
);

CREATE TABLE context_entries (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  companion TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);
```

---

## CONTEXT HANDOFF PATTERN

This is the Re-Briefing Tax elimination mechanism. It must be
visible to the user.

When Klimt dispatches to a specialist:
1. Read the full `context_entries` array for the active session
2. Pass it as conversation history in the specialist's system prompt
3. Specialist responds with full context awareness
4. Append the specialist response to `context_entries`
5. Return control to Klimt
6. Klimt continues — context intact, no reset

The user sees: different voice, same thread. That is the demo.

---

## UI REQUIREMENTS

**Always visible:**
- Companion status panel — shows which companion is active
- Session context indicator — shows context is persisting
- Current companion name and voice label

**Companion response panel:**
- Scrollable conversation thread
- Each message labelled with companion name
- Cited sources rendered for Tavily responses
- Images rendered inline for Auren responses
- Copy to clipboard button on each response

**Voice:**
- Auto-play companion voice on each response
- Clear visual indicator while audio is playing
- Graceful fallback if audio fails — text still displays

**Dark theme colours:**
- Background: `#0a0e1a`
- Cyan accent: `#00d4ff`
- Gold highlight: `#f5c518`
- Text: `#ffffff`
- Muted: `#8892a4`

---

## BUILD SEQUENCE — FOLLOW THIS ORDER. NO SKIPPING.

Each phase gates the next. Do not move to the next phase until
the current phase is working end to end.

### P1 — Supabase Setup
- Apply the sessions and context_entries schema to the crack-on
  Supabase project
- Confirm read and write from local env
- Test: create a session, write a context entry, read it back
- Gate: Supabase connection confirmed working before any UI work

### P2 — Klimt Core
- Plain HTML shell with dark theme
- Single input field and response panel
- Klimt API call (claude-sonnet-4-6) with system prompt
- Write user message and Klimt response to context_entries
- ElevenLabs TTS for Klimt voice (Cevin)
- Gate: single-companion loop working end to end with voice

### P3 — Tavily Integration
- Intent classifier: detect citation_required or current_events
  keywords in user input
- Dispatch to Tavily /search when triggered
- Pass full context_entries as context to Tavily call
- Render cited results in UI with source attribution
- Append Tavily response to context_entries
- ElevenLabs TTS for Tavily voice (Maya — replaced the flatter default
  "Jane" voice, then "Domi", with a clearer premade ElevenLabs voice)
- Return to Klimt after Tavily response
- Gate: Klimt → Tavily → Klimt loop working with context intact

### P4 — Nebius Integration
- Extend intent classifier: detect open_source_compute keywords
- Dispatch to Nebius Token Factory (Qwen/Qwen3-30B-A3B-Instruct-2507 —
  fast MoE model available on this account's Nebius public endpoint; no
  Llama model of any size is available on this key)
- Base URL: https://api.studio.nebius.com/v1 (OpenAI-compatible)
- Pass full context_entries as conversation history
- Append Nebius response to context_entries
- ElevenLabs TTS for Nebius voice (Steve)
- Return to Klimt after Nebius response
- Gate: Klimt → Nebius → Klimt loop working with context intact

### P5 — Auren Integration
- Extend intent classifier: detect image_generation keywords
- Dispatch to OpenAI gpt-5.5
- Attempt gpt-image-1 image generation for visual tasks (DALL-E 3 is not
  available on this account's OpenAI plan)
- If gpt-image-1 unavailable: fall back to gpt-5.5
  conversational response only — do not break the demo
- Render generated image inline in response panel
- Append Auren response to context_entries
- ElevenLabs TTS for Auren voice (Guy)
- Return to Klimt after Auren response
- Gate: Klimt → Auren → Klimt loop working with context intact

### P6 — Context Persistence Demo
- Session persists across browser refresh
- On page load: check Supabase for existing session
- If session exists: load context_entries and resume
- Klimt opening message acknowledges the resumption explicitly:
  "Welcome back. I remember where we were."
- The RBT elimination moment must be explicit and visible in the UI
- Gate: close browser, reopen, Klimt resumes with full context

### P7 — UI Polish
- Crack On brand identity applied throughout
- Logo in /assets/ used in header
- Companion status panel styled and prominent
- Smooth voice transitions between companions
- Companion switch is visually clear — name, voice label, colour
  indicator per companion
- Mobile-responsive layout

### P8 — Video
- Screen recording of full demo flow (P1 → P8 demo sequence)
- Voiceover narrating the RBT elimination moment
- 60–90 seconds maximum
- Upload to YouTube (unlisted or public)
- This video doubles as the NVIDIA Inception demo asset

### P9 — Devpost Submission
- Submit at devpost.com by 30 October 2026
- Include YouTube video link
- Tag city as Taipei
- Prize tracks: Physical AI (primary), Personal AI (secondary),
  Best Use of Tavily
- Devpost description: RBT elimination story, Nebius/NVIDIA angle,
  omnipresence framing. No PC IP narrative.

---

## ARCHITECTURAL PRINCIPLES

| Principle | Meaning |
|-----------|---------|
| **Klimt is always Klimt** | The anchor companion never changes. Context always flows back to Klimt. The user always has a home. |
| **Context is the product** | The demo is not about AI responses. It is about context surviving the switch. Every design decision serves this. |
| **Simple routing** | Keyword-based intent classification only. No PC router logic. Clean and auditable. |
| **Fail gracefully** | If a specialist fails, Klimt handles the task. No broken demo states. |
| **IP boundary first** | If in doubt about whether something belongs in the public repo — it does not. |
| **Build order is the order** | P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9. No skipping. Each phase gates the next. |

---

## FIRST PROMPT TO CODY

```
Read CLAUDE_CRACK_ON.md in full before writing any code.

Start at P1 — Supabase Setup.

Apply the sessions and context_entries schema to the Supabase
crack-on project using the credentials in .env. Confirm the
connection is working by creating a test session and writing
a test context entry. Show me the Supabase table output
confirming the rows were written.

Do not proceed to P2 until P1 is confirmed working.
```

---

*NST-PC-CO-CD-001 V1.0 | NeoSoulTech Ltd | September 2026*
*Internal use only — Crack On is a public repo. This file contains*
*internal reference only. Do not commit build instructions that*
*reference NST or PC architecture.*
