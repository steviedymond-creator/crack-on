// Crack On backend — serves the static frontend and proxies companion/TTS
// calls so secret API keys never reach the browser.
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function loadEnv(path) {
  const env = {};
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    // No .env file, for example on a host that sets values in its own dashboard.
    if (err.code !== 'ENOENT') throw err;
  }
  for (const rawLine of raw.split('\n')) {
    // Strip a trailing carriage return so Windows line endings load the same.
    const line = rawLine.replace(/\r$/, '');
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  // Real system environment values override the file.
  for (const [name, value] of Object.entries(process.env)) {
    if (/^[A-Z_]+$/.test(name) && value) env[name] = value;
  }
  return env;
}

const env = loadEnv(join(ROOT, '.env'));
const PORT = process.env.PORT || 3000;

// Edison needs both NVIDIA settings. Warn (names only, never values) and
// keep starting — a missing one just makes Klimt cover for Edison.
const missingNvidiaVars = ['NVIDIA_BASE_URL', 'NVIDIA_API_KEY'].filter((name) => !env[name]);
if (missingNvidiaVars.length) {
  console.warn(`[Startup] Edison will be unavailable — missing: ${missingNvidiaVars.join(', ')}`);
}
// The server should hold the private Supabase key. Without it the anon key is
// used instead. Warn with the name only, never the value.
if (!env.SUPABASE_SERVICE_KEY) {
  console.warn('[Startup] SUPABASE_SERVICE_KEY is missing — falling back to the anon key');
}
// Optional access code for the API. Unset or empty leaves the gate off.
// Say whether it is on, by name only, never the value.
const ACCESS_CODE = env.ACCESS_CODE;
console.log(`[Startup] Access gate (ACCESS_CODE) is ${ACCESS_CODE ? 'on' : 'off'}`);

const KLIMT_SYSTEM_PROMPT =
  'You are Klimt, the orchestrating anchor companion for Crack On. ' +
  'You keep the conversation thread intact for the user no matter what ' +
  'happens. Be warm, concise, and helpful. ' +
  'You are the anchor companion in a multi-companion system. When you see ' +
  'messages attributed to [Tavily], [Nebius], [Auren], or [Edison] in the ' +
  'conversation history, these are your specialist companions who handled ' +
  'those queries. You are aware of everything they said and can reference ' +
  'their responses. You did not answer those questions yourself — your ' +
  'specialists did. Be honest about this. ' +
  'If the user addresses Edison, Tavily or Nebius and the message reached ' +
  'you, acknowledge them warmly, say you cannot pass messages along ' +
  'yourself, and tell the user to start their message with that ' +
  'companion\'s name and a comma, for example "Edison, ...". ' +
  'Never be territorial or dismissive.';

const KLIMT_HANDOFF_SYSTEM_PROMPT =
  'You are Klimt, the orchestrating anchor companion for Crack On. ' +
  'You are delegating this request to a specialist companion. ' +
  'Respond with a single warm, natural handoff line addressed to the ' +
  'specialist by name. Keep it brief, characterful, and conversational. ' +
  'Examples: "Auren — Stevie wants a surreal version of The Kiss. Over to you." ' +
  'or "Tavily — can you grab that stock price for us?" ' +
  'or "Nebius — this one\'s yours. Over to you." ' +
  'or "Edison — this needs some serious analytical weight. Over to you." ' +
  'One line only. No explanation. No follow-up.';

// Keyword-based intent classification only — no PC router logic.
// Tavily is the fast, reliable general information specialist (citation +
// current-events triggers). Nebius fires only on narrow open-source
// compute keywords so it stays rare during live demos (it is much slower).
const CITATION_KEYWORDS = ['cite', 'citation', 'source', 'according to', 'reference', 'proof'];
const CURRENT_EVENTS_KEYWORDS = ['today', 'latest', 'recent', 'news', 'this week', 'right now', 'currently', 'happening now', 'stock price', 'earnings', 'announcement'];
const OPEN_SOURCE_COMPUTE_KEYWORDS = [
  'open source model', 'open-source model', 'llama', 'qwen',
  'neural network weights', 'transformer architecture', 'fine-tuning',
  'gpu inference', 'language model weights', 'open source language',
];
const IMAGE_GENERATION_KEYWORDS = [
  'generate an image', 'draw', 'picture of', 'image of', 'create an image',
  'illustration', 'photo of', 'paint', 'cartoon', 'sketch', 'render',
  'visualise', 'visualize', 'graphic of', 'show me a', 'create a',
  'make a picture', 'make an image', 'design a', 'artwork',
];
// Edison owns deep technical analysis/architecture; Nebius stays the
// open-source-model explainer. A stock/market query always wins so
// "nvidia" never bleeds NVIDIA stock-price questions away from Tavily.
const EDISON_KEYWORDS = [
  'architecture', 'analyse', 'analyze', 'deep dive', 'technical analysis',
  'how does it work', 'internals', 'benchmark', 'research', 'paper',
  'engineering', 'system design', 'in depth', 'explain technically',
  'transformer', 'attention mechanism', 'training', 'fine-tuning',
  'inference', 'gpu', 'cuda', 'nvidia', 'hardware',
];
const STOCK_MARKET_KEYWORDS = ['stock', 'price', 'shares', 'market cap'];

// Returns 'edison', 'tavily' or 'nebius' when the message starts with that
// name followed by a comma, colon, semicolon or dash; otherwise null.
function detectAddressedCompanion(message) {
  const match = /^\s*(edison|tavily|nebius)\s*[,:;\-–—]/i.exec(message);
  return match ? match[1].toLowerCase() : null;
}

function classifyIntent(message) {
  const text = message.toLowerCase();

  const addressed = detectAddressedCompanion(message);
  if (addressed) {
    return {
      companion: addressed,
      depth: addressed === 'tavily' ? 'basic' : undefined,
      label: INTENT_LABEL_BY_COMPANION[addressed],
      reason: 'addressed by name',
      handoff: true,
      ...(addressed === 'tavily' && CURRENT_EVENTS_KEYWORDS.some((kw) => text.includes(kw)) ? { recency: true } : {}),
    };
  }

  const imageMatch = IMAGE_GENERATION_KEYWORDS.find((kw) => text.includes(kw));
  if (imageMatch) {
    return { companion: 'auren', label: 'image_generation', reason: `matched image keyword "${imageMatch}"`, handoff: true };
  }

  const isStockQuery = STOCK_MARKET_KEYWORDS.some((kw) => text.includes(kw));
  const isCurrentEventsQuery = CURRENT_EVENTS_KEYWORDS.some((kw) => text.includes(kw));

  const openSourceMatch = OPEN_SOURCE_COMPUTE_KEYWORDS.find((kw) => text.includes(kw));
  if (openSourceMatch) {
    return { companion: 'nebius', label: 'open_source_compute', reason: `matched open-source-compute keyword "${openSourceMatch}"`, handoff: true };
  }

  const edisonMatch = !isStockQuery && !isCurrentEventsQuery && EDISON_KEYWORDS.find((kw) => text.includes(kw));
  if (edisonMatch) {
    return { companion: 'edison', label: 'deep_technical_analysis', reason: `matched edison keyword "${edisonMatch}"`, handoff: true };
  }

  const citationMatch = CITATION_KEYWORDS.find((kw) => text.includes(kw));
  const currentEventsMatch = CURRENT_EVENTS_KEYWORDS.find((kw) => text.includes(kw));
  if (citationMatch || currentEventsMatch) {
    return {
      companion: 'tavily',
      depth: citationMatch ? 'advanced' : 'basic',
      label: 'citation_required',
      reason: `matched ${citationMatch ? 'citation' : 'current-events'} keyword "${citationMatch ?? currentEventsMatch}"`,
      handoff: true,
      ...(currentEventsMatch ? { recency: true } : {}),
    };
  }

  return { companion: 'klimt', label: 'general', reason: 'no specialist keyword matched (default)' };
}

// Used to restore meta.intent when /api/message receives a pre-classified
// companion override from a prior /api/handoff call (skips classifyIntent).
const INTENT_LABEL_BY_COMPANION = {
  klimt: 'general',
  tavily: 'citation_required',
  nebius: 'open_source_compute',
  auren: 'image_generation',
  edison: 'deep_technical_analysis',
};

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function supabaseHeaders() {
  const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function createSession() {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ surface: 'web', user_id: 'anonymous' }),
  });
  if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
  const [session] = await res.json();
  return session;
}

async function getContextEntries(sessionId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/context_entries?session_id=eq.${encodeURIComponent(sessionId)}&select=*&order=created_at.asc`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`getContextEntries failed: ${res.status}`);
  return res.json();
}

async function appendContextEntry(sessionId, companion, role, content, metadata = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/context_entries`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ session_id: sessionId, companion, role, content, metadata }),
  });
  if (!res.ok) throw new Error(`appendContextEntry failed: ${res.status}`);
  const [entry] = await res.json();
  return entry;
}

// Specialist replies are attributed inline ("[Tavily]: ...") so Klimt can
// see and reference what each companion said instead of thinking he wrote it.
function attributeEntryContent(entry) {
  if (entry.role !== 'assistant' || !entry.companion || entry.companion === 'klimt') {
    return entry.content;
  }
  const label = entry.companion.charAt(0).toUpperCase() + entry.companion.slice(1);
  return `[${label}]: ${entry.content}`;
}

// Pulls reply text out of a chat-completion `content` value: a string, or an
// array of parts (first part with non-empty text wins). Anything else, or
// whitespace only, returns '' so callers can treat it as an empty reply.
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const part = content.find((p) => typeof p?.text === 'string' && p.text.trim());
    return part ? part.text.trim() : '';
  }
  return '';
}

async function callKlimt(history, userMessage, systemPrompt = KLIMT_SYSTEM_PROMPT) {
  const messages = history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => ({ role: entry.role, content: attributeEntryContent(entry) }));
  messages.push({ role: 'user', content: userMessage });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Klimt call failed: ${res.status}`);
  const data = await res.json();
  const block = Array.isArray(data.content)
    ? data.content.find((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
    : null;
  return block ? block.text : '';
}

// Klimt speaks a one-line handoff addressed to the specialist by name before
// the specialist actually fires, making the delegation visible in-thread.
async function callKlimtHandoff(history, userMessage, companion) {
  const specialistName = companion.charAt(0).toUpperCase() + companion.slice(1);
  const prompt = `The user just said: "${userMessage}"\n\nDeliver your one-line handoff to ${specialistName}, your specialist companion who will handle this request.`;
  return callKlimt(history, prompt, KLIMT_HANDOFF_SYSTEM_PROMPT);
}

const KLIMT_SUBSTITUTE_SYSTEM_PROMPT =
  'You are Klimt, the orchestrating anchor companion for Crack On. ' +
  'A specialist companion is temporarily unavailable and you are stepping in. ' +
  'Begin with exactly one short natural line — for example: ' +
  '"Edison\'s tied up — I\'ve got this one." ' +
  'or "Tavily\'s unavailable — let me take this." ' +
  'Then answer the question fully and helpfully in your own voice. ' +
  'Do not explain that Edison is unavailable at length. ' +
  'Do not answer in Edison\'s style. Answer as Klimt. ' +
  'One handback line only, then straight into the answer.';

// Fires when a specialist call reports substituteKlimt:true — Klimt answers
// the original question directly, opening with a natural handback line.
async function callKlimtSubstitute(history, userMessage, failedCompanion) {
  const specialistName = failedCompanion.charAt(0).toUpperCase() + failedCompanion.slice(1);
  const prompt = `${specialistName} is unavailable right now. The user asked: "${userMessage}"\n\nStep in and answer this yourself, per your instructions.`;
  return callKlimt(history, prompt, KLIMT_SUBSTITUTE_SYSTEM_PROMPT);
}

// Same fail-open pattern, scoped to a single mid-sequence step — a brief
// coverage line plus a stopgap attempt, not a full answer, so the next
// specialist in the sequence has something real to build on.
const KLIMT_SEQUENCE_SUBSTITUTE_SYSTEM_PROMPT = `You are Klimt, the orchestrating anchor companion for Crack On. A specialist companion is unavailable mid-sequence and you are covering their step so the sequence can continue. Begin with one short natural coverage line — for example: "Edison's tied up, so I'll cover this step." Then give a brief, useful attempt at the instruction so the next specialist in the sequence has something real to build on. Keep it concise — this is a stopgap step, not a full answer.`;

async function callKlimtSequenceSubstitute(history, instruction, failedCompanion, sequenceContext) {
  const specialistName = failedCompanion.charAt(0).toUpperCase() + failedCompanion.slice(1);
  const prompt = `${specialistName} is unavailable for this step. The instruction was: "${instruction}"\n\nCover this step yourself, per your instructions.`;
  const systemPrompt = sequenceContext
    ? `${sequenceContext}\n\n${KLIMT_SEQUENCE_SUBSTITUTE_SYSTEM_PROMPT}`
    : KLIMT_SEQUENCE_SUBSTITUTE_SYSTEM_PROMPT;
  return callKlimt(history, prompt, systemPrompt);
}

// Klimt's closing line for a multi-specialist sequence — wraps every
// specialist's output into one coherent conclusion, spoken to the user.
const KLIMT_SYNTHESIS_SYSTEM_PROMPT = `You are Klimt, the orchestrating anchor companion for Crack On. You are closing out a multi-specialist sequence. You have been given the full accumulated output of every specialist who worked this request, in order. Bring it together into one coherent, warm conclusion for the user — do not just repeat each specialist verbatim, genuinely synthesise what they produced into a single answer. Speak as the orchestrator wrapping up the team's work, not as any one specialist.`;

// Klimt's planning call decides ONLY whether a request is genuinely
// multi-specialist — it never re-picks the single companion (classifyIntent
// stays authoritative for that via resolveHandoff), so the single-specialist
// path is structurally guaranteed identical regardless of this call's output.
const KLIMT_PLANNING_SYSTEM_PROMPT = `You are Klimt, the orchestrating anchor companion for Crack On.
Your job right now is ONLY to decide whether the user's request genuinely requires MULTIPLE specialist companions working in sequence, or whether a single specialist (or a general conversational reply) is sufficient. Do not attempt to pick which single companion should handle a single-specialist request — that is handled elsewhere.
Available specialists and their domains:
- auren: image generation, visual creative work
- tavily: current events, citations, web-grounded answers, news
- nebius: open source models, LLM weights, GPU inference, fine-tuning
- edison: deep technical analysis, architecture, CUDA, GPU, hardware internals, NVIDIA (non-financial)
A request only needs MULTIPLE specialists when it genuinely spans more than one of these distinct domains and would benefit from specialists building on each other's work in sequence (e.g. a technical analysis feeding a visual, or a visual then getting technically reviewed). Simple requests, even if they mention a specialist's domain once, are single-specialist.
Do not include klimt in the sequence array itself — klimt is not a sequence step, only the foundation (before) and the synthesis (after) belong to Klimt, handled separately.
If NOT multi-specialist, respond with exactly this JSON and nothing else:
{"multi": false}
If genuinely multi-specialist, respond with valid JSON only — no prose, no markdown code fences — in exactly this shape:
{"multi": true, "foundation": "<a short warm line, spoken to the user, naming which specialists will work this and in what order>", "sequence": [{"step": 1, "companion": "<name>", "instruction": "<a specific scoped task for this step, not the raw user query>"}], "synthesis_prompt": "<an instruction for your own closing synthesis once all specialists have run>"}
The sequence may be any length and the same specialist may appear more than once, each appearance with its own instruction. Output valid JSON only — nothing before or after it.`;

async function callKlimtPlanner(history, message, contextSummary) {
  const prompt = contextSummary
    ? `Conversation so far:\n${contextSummary}\n\nCurrent user request: ${message}`
    : `Current user request: ${message}`;
  const raw = await callKlimt(history, prompt, KLIMT_PLANNING_SYSTEM_PROMPT);
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || parsed.multi !== true) {
    return { multi: false };
  }
  const sequence = Array.isArray(parsed.sequence) ? parsed.sequence : [];
  const validSequence = sequence.length > 0 && sequence.every(
    (step) => step && typeof step.companion === 'string' && typeof step.instruction === 'string'
  );
  if (!validSequence || typeof parsed.foundation !== 'string' || typeof parsed.synthesis_prompt !== 'string') {
    return null; // malformed multi plan — fail open to the single-specialist path
  }
  return {
    multi: true,
    foundation: parsed.foundation,
    sequence: sequence.map((step, i) => ({
      step: typeof step.step === 'number' ? step.step : i + 1,
      companion: step.companion,
      instruction: step.instruction,
    })),
    synthesis_prompt: parsed.synthesis_prompt,
  };
}

// Single-specialist classification + handoff, shared by /api/handoff and
// /api/plan so the single-specialist path is byte-identical either way.
async function resolveHandoff(sessionId, message) {
  const intent = classifyIntent(message);
  if (!intent.handoff) {
    return { handoff: false };
  }
  // Klimt only speaks a handoff line for Auren — every other specialist
  // routes silently (Under the Hood routing/handoff lines still fire
  // client-side regardless, this only controls the spoken/rendered line).
  if (intent.companion !== 'auren') {
    return {
      handoff: true,
      speakHandoff: false,
      handoffReply: null,
      handoffCompanion: null,
      companion: intent.companion,
      depth: intent.depth,
    };
  }
  // Klimt's handoff line is read-only — no context_entries write here, the
  // /api/message call that follows persists the actual user/assistant turn.
  try {
    const history = await getContextEntries(sessionId);
    const handoffReply = await callKlimtHandoff(history, message, intent.companion);
    return {
      handoff: true,
      speakHandoff: true,
      handoffReply,
      handoffCompanion: 'klimt',
      companion: intent.companion,
      depth: intent.depth,
    };
  } catch (err) {
    // Fail-open — client falls through to a direct /api/message dispatch.
    console.error('[Handoff] Error:', err.message);
    return { handoff: false };
  }
}

// Formats accumulated multi-specialist sequence output into the block
// prepended to a specialist's system prompt/query for /api/sequence/step —
// step numbers are derived from array position (foundation excluded).
function buildSequenceContextBlock(context, instruction) {
  const lines = ['SEQUENCE CONTEXT — what has been produced so far:'];
  let stepCounter = 0;
  for (const item of context) {
    if (!item || typeof item.content !== 'string') continue;
    if (item.role === 'klimt_foundation') {
      lines.push(`[Klimt Foundation]: ${item.content}`);
    } else {
      stepCounter += 1;
      const label = String(item.role).charAt(0).toUpperCase() + String(item.role).slice(1);
      lines.push(`[${label} Step ${stepCounter}]: ${item.content}`);
    }
  }
  lines.push(`Your instruction for this step: ${instruction}`);
  return lines.join('\n');
}

const NEBIUS_SYSTEM_PROMPT =
  'You are Nebius, the open-source compute specialist for Crack On. ' +
  'Respond concisely in plain prose — quality over length, no tables, no ' +
  'headers, minimal formatting. Always end with a "## Summary" section ' +
  'containing 3-5 short bullet points capturing the key takeaways — only ' +
  'that summary will be read aloud via text-to-speech, so it must stand ' +
  'on its own.';

// Short reason code for the browser's Under the Hood line — never the error
// message itself, which can carry response bodies.
function failureCode(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  if (err?.message === 'empty reply') return 'empty';
  const status = /(?:HTTP |failed: )(\d{3})\b/.exec(err?.message ?? '');
  if (status) return `http_${status[1]}`;
  return 'error';
}

async function callNebius(history, userMessage, sequenceContext = '') {
  const systemContent = sequenceContext ? `${sequenceContext}\n\n${NEBIUS_SYSTEM_PROMPT}` : NEBIUS_SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: systemContent },
    ...history
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user', content: userMessage },
  ];

  try {
    const res = await fetch('https://api.studio.nebius.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
        max_tokens: 400,
        messages,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Nebius call failed: ${res.status}`);
    const data = await res.json();
    const reply = extractText(data.choices?.[0]?.message?.content);
    if (!reply) throw new Error('empty reply');
    return { reply, companion: 'nebius' };
  } catch (err) {
    console.error('[Nebius] Error:', err.message);
    return { reply: null, substituteKlimt: true, companion: 'nebius', failedCompanion: 'nebius', failureReason: failureCode(err) };
  }
}

const EDISON_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const EDISON_SYSTEM_PROMPT =
  'You are Edison, a deep technical analysis companion in the Crack On ensemble. ' +
  'You are powered by NVIDIA Nemotron — built for long-context reasoning and technical depth. ' +
  'When you are called, the question requires serious analytical weight. ' +
  'Be direct, precise, and structured. ' +
  'CRITICAL: Never use LaTeX notation or raw mathematical formulae. ' +
  'Express all mathematical concepts in plain English — write out what the formula means, ' +
  'not the formula itself. ' +
  'Structure your response with clear headings and bullet points. ' +
  'Keep individual bullet points concise — one idea per bullet. ' +
  'This is a voice-capable interface: every sentence must sound natural when spoken aloud. ' +
  'Do not write anything that would sound unnatural or robotic if read by a voice narrator. ' +
  'IDENTITY: You are Edison, not Klimt. You never announce or acknowledge a handoff, ' +
  'never refer to yourself in the third person, and never promise to deliver an answer later. ' +
  'Begin directly with the technical analysis itself and answer the question in this reply. ' +
  'Every reply must open with a plain-English opening of exactly two sentences, written as ordinary ' +
  'prose before any heading or bullet points. ' +
  'The first sentence is one short greeting in your own voice that names you as Edison, about 60 characters ' +
  'at most, for example "Edison here, let\'s dig in." ' +
  'The second sentence directly answers the question in about 200 characters at most. ' +
  'Both sentences must end with a full stop or exclamation mark. ' +
  'The greeting must not mention a handoff, must never refer to Klimt, and must not use any person\'s name. ' +
  'That opening must not be a heading and must not be a bullet. ' +
  'Aim for a reply of around 350 words. ' +
  'If the user asks for a specific length or format, for example "in one or two sentences" ' +
  'or "in two sentences", follow it exactly, with no headings or bullet lists. ' +
  'This overrides the structure, opening and length rules above.';

// Fails open internally (never throws) — same pattern as callAuren, so
// /api/message's outer fallback-to-Klimt never needs to fire for Edison.
async function callEdison(history, userMessage, sequenceContext = '') {
  const systemContent = sequenceContext ? `${sequenceContext}\n\n${EDISON_SYSTEM_PROMPT}` : EDISON_SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: systemContent },
    // Other companions' assistant turns are dropped so they never read as
    // Edison's own prior speech (attributeEntryContent leaves Klimt's turns
    // unlabelled, so it can't make this attribution on its own).
    ...history
      .filter((entry) => entry.role === 'user' || (entry.role === 'assistant' && entry.companion === 'edison'))
      .map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user', content: userMessage },
  ];

  const startedAt = Date.now();
  try {
    const res = await fetch(`${env.NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EDISON_MODEL,
        max_tokens: 4096,
        chat_template_kwargs: { enable_thinking: false },
        messages,
      }),
      signal: AbortSignal.timeout(60000),
    });
    // Status only — the response body is left out so nothing sensitive is logged.
    if (!res.ok) throw new Error(`Edison call failed: HTTP ${res.status}`);
    const data = await res.json();
    const reply = extractText(data.choices?.[0]?.message?.content);
    if (!reply) {
      // TEMP DIAGNOSTIC (remove): structure only, never content.
      const choice = data.choices?.[0];
      const msg = choice?.message;
      const contentType = msg?.content === null ? 'null' : Array.isArray(msg?.content) ? 'array' : typeof msg?.content;
      console.error(`[Edison][diag] message keys: ${msg && typeof msg === 'object' ? Object.keys(msg).join(',') : 'none'}; content type: ${contentType}; finish_reason: ${String(choice?.finish_reason).slice(0, 20)}; usage: prompt=${Number(data.usage?.prompt_tokens)} completion=${Number(data.usage?.completion_tokens)} total=${Number(data.usage?.total_tokens)}`);
      throw new Error('empty reply');
    }
    return { reply, companion: 'edison' };
  } catch (err) {
    console.error(`[Edison] Error after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${err.message}`);
    return { reply: null, substituteKlimt: true, companion: 'edison', failedCompanion: 'edison', failureReason: failureCode(err) };
  }
}

const AUREN_IMAGE_SUCCESS_SYSTEM_PROMPT =
  'You are Auren, the creative visual companion for Crack On. You just ' +
  'successfully generated the image the user asked for — it is already ' +
  'rendered above your reply. Respond with one brief, confident line that ' +
  'complements the image, e.g. "Here\'s what I created for you." Never say ' +
  'you can\'t draw, and never suggest another tool — the image already exists.';
const AUREN_IMAGE_FAILURE_SYSTEM_PROMPT =
  'You are Auren, the creative visual companion for Crack On. Image ' +
  'generation failed for this request. Briefly and kindly explain that and ' +
  'suggest the user try again or rephrase the request.';

async function callAuren(history, userMessage, sequenceContext = '') {
  try {
    let imageUrl;
    try {
      const imagePrompt = sequenceContext ? `${sequenceContext}\n\n${userMessage}` : userMessage;
      const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'gpt-image-2.5-flare', prompt: imagePrompt, n: 1, size: '1024x1024' }),
      });
      if (imgRes.ok) {
        const imgData = await imgRes.json();
        const b64 = imgData.data?.[0]?.b64_json;
        imageUrl = b64 ? `data:image/png;base64,${b64}` : undefined;
      } else {
        console.warn(`Auren image generation unavailable: ${imgRes.status}`);
      }
    } catch (err) {
      console.warn('Auren image generation failed:', err.message);
    }

    const baseAurenSystemPrompt = imageUrl ? AUREN_IMAGE_SUCCESS_SYSTEM_PROMPT : AUREN_IMAGE_FAILURE_SYSTEM_PROMPT;
    const systemContent = sequenceContext ? `${sequenceContext}\n\n${baseAurenSystemPrompt}` : baseAurenSystemPrompt;
    const messages = [
      { role: 'system', content: systemContent },
      ...history
        .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
        .map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userMessage },
    ];

    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages }),
    });
    if (!chatRes.ok) throw new Error(`Auren chat call failed: ${chatRes.status}`);
    const chatData = await chatRes.json();
    const reply = extractText(chatData.choices?.[0]?.message?.content);
    if (!reply) throw new Error('empty reply');
    return { reply, imageUrl, companion: 'auren' };
  } catch (err) {
    console.error('Auren call failed entirely:', err.message);
    return { reply: null, substituteKlimt: true, companion: 'auren', failedCompanion: 'auren', failureReason: failureCode(err) };
  }
}

function buildContextSummary(history, maxEntries = 4, maxCharsPerEntry = 150) {
  return history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .slice(-maxEntries)
    .map((entry) => {
      const snippet = entry.content.length > maxCharsPerEntry
        ? `${entry.content.slice(0, maxCharsPerEntry)}…`
        : entry.content;
      return `${entry.role === 'user' ? 'User' : entry.companion}: ${snippet}`;
    })
    .join('\n');
}

async function callTavily(history, query, depth, sequenceContext = '', recency = false) {
  // Drop a leading "Tavily, " style address from the search query only; the
  // stored and displayed message is unchanged.
  query = query.replace(/^\s*(edison|tavily|nebius)\s*[,:;\-–—]/i, '').trim() || query;
  // Recency (news) searches use the current question only, no conversation summary.
  const contextSummary = recency ? '' : buildContextSummary(history);
  let contextualQuery = contextSummary
    ? `Conversation so far:\n${contextSummary}\n\nCurrent question: ${query}`
    : query;
  // Tavily rejects queries over 1500 chars — trim the summary, never the question.
  const MAX_QUERY_LENGTH = 1400;
  if (contextualQuery.length > MAX_QUERY_LENGTH) {
    const prefix = 'Conversation so far:\n';
    const suffix = `\n\nCurrent question: ${query}`;
    const availableForSummary = Math.max(MAX_QUERY_LENGTH - prefix.length - suffix.length, 0);
    contextualQuery = `${prefix}${contextSummary.slice(-availableForSummary)}${suffix}`;
  }
  // Sequence context is prepended after the existing trimming logic so the
  // single-specialist path above is untouched byte-for-byte when absent.
  if (sequenceContext) {
    contextualQuery = `${sequenceContext}\n\n${contextualQuery}`;
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: contextualQuery,
      search_depth: depth,
      include_answer: true,
      max_results: 5,
      ...(recency ? { topic: 'news', time_range: 'week' } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Tavily call failed: ${res.status}`);
  const data = await res.json();
  const sources = (data.results ?? []).map((r) => ({ title: r.title, url: r.url }));
  const reply = data.answer || 'No grounded answer found for that query.';
  return { reply, sources, companion: 'tavily' };
}

const MAX_BODY_BYTES = 100 * 1024;

async function readJsonBody(req) {
  const tooLarge = () => Object.assign(new Error('request body too large'), { statusCode: 413 });
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Voice output must be plain speech — strip Markdown syntax before ElevenLabs.
function stripMarkdown(text) {
  return text
    // Drop fenced/inline code entirely — reading code aloud is meaningless.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/^[\s*_-]{3,}$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Strip any remaining hash symbols, arrows, and code-style brackets.
    .replace(/#/g, '')
    .replace(/[→←↔⇒⇐⇔]/g, ' ')
    .replace(/-{1,2}>/g, ' ')
    .replace(/<-{1,2}/g, ' ')
    .replace(/[[\]{}]/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Nebius responses end with a "## Summary" heading — only that section
// should be spoken aloud, not the full detailed body.
function extractTtsText(text) {
  const match = text.match(/^#{1,6}\s*.*\bsummary\b.*$/im);
  if (!match) return text;
  return text.slice(match.index + match[0].length);
}

// The voice IDs the browser may use; /api/config lists them and /api/tts
// accepts only these.
const VOICES = {
  klimt: env.ELEVENLABS_VOICE_KLIMT,
  tavily: env.ELEVENLABS_VOICE_TAVILY,
  nebius: env.ELEVENLABS_VOICE_NEBIUS,
  auren: env.ELEVENLABS_VOICE_AUREN,
  edison: env.ELEVENLABS_VOICE_EDISON,
};

// Access gate: when ACCESS_CODE is set, every API request must send it in the
// x-access-code header. Unset or empty leaves the API open, as for local use.
function hasValidAccessCode(req) {
  if (!ACCESS_CODE) return true;
  const given = Buffer.from(String(req.headers['x-access-code'] ?? ''));
  const expected = Buffer.from(ACCESS_CODE);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Per-client request limits, in memory. Each entry is one fixed one-minute
// window. Expired entries are swept every minute and the map has a hard size
// cap, so it cannot grow without limit.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PAID = 30;
const RATE_LIMIT_TTS = 30; // for /api/tts
const RATE_LIMIT_IMAGE = 6; // for image generation, counted separately from TTS
const RATE_MAX_ENTRIES = 10_000;
const rateEntries = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateEntries) {
    if (entry.resetAt <= now) rateEntries.delete(key);
  }
}, RATE_WINDOW_MS).unref();

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first || req.socket.remoteAddress || 'unknown';
}

// Counts this request against the named limit; true means it is over the limit.
function isRateLimited(req, bucket, max) {
  const key = `${bucket}|${clientAddress(req)}`;
  const now = Date.now();
  let entry = rateEntries.get(key);
  if (!entry || entry.resetAt <= now) {
    if (!entry && rateEntries.size >= RATE_MAX_ENTRIES) {
      rateEntries.delete(rateEntries.keys().next().value);
    }
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateEntries.set(key, entry);
  }
  entry.count += 1;
  return entry.count > max;
}

function sendTooManyRequests(res) {
  res.statusCode = 429;
  res.end(JSON.stringify({ error: 'too many requests' }));
}

const PAID_ROUTES = new Set(['/api/greet', '/api/handoff', '/api/plan', '/api/sequence/step', '/api/message']);

async function handleApi(req, res, url) {
  res.setHeader('Content-Type', 'application/json');

  if (!hasValidAccessCode(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'access code required' }));
    return;
  }

  if (req.method === 'POST') {
    const limited = url.pathname === '/api/tts'
      ? isRateLimited(req, 'tts', RATE_LIMIT_TTS)
      : PAID_ROUTES.has(url.pathname) && isRateLimited(req, 'paid', RATE_LIMIT_PAID);
    if (limited) {
      sendTooManyRequests(res);
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.end(JSON.stringify({
      voices: VOICES,
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    const session = await createSession();
    res.end(JSON.stringify(session));
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/session\/[^/]+\/context$/)) {
    const sessionId = url.pathname.split('/')[3];
    const entries = await getContextEntries(sessionId);
    res.end(JSON.stringify(entries));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/greet') {
    const { sessionId } = await readJsonBody(req);
    if (!sessionId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return;
    }
    // No user turn to persist here — this is Klimt opening the thread
    // unprompted, so only the assistant reply is written to context_entries.
    const reply = await callKlimt(
      [],
      'Greet me briefly as Klimt, opening a brand new session. Introduce yourself in one short sentence and ask what we are working on today.'
    );
    const assistantEntry = await appendContextEntry(sessionId, 'klimt', 'assistant', reply);
    res.end(JSON.stringify({ companion: 'klimt', reply, entry: assistantEntry }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/handoff') {
    const { sessionId, message } = await readJsonBody(req);
    if (!sessionId || !message) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId and message are required' }));
      return;
    }
    const result = await resolveHandoff(sessionId, message);
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/plan') {
    const { sessionId, message } = await readJsonBody(req);
    if (!sessionId || !message) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId and message are required' }));
      return;
    }
    // Klimt's planning call decides ONLY whether this is genuinely
    // multi-specialist — it never re-picks the single companion, that
    // stays with classifyIntent via resolveHandoff below, so the
    // single-specialist path is guaranteed identical to pre-plan behaviour.
    let planResult = null;
    try {
      const history = await getContextEntries(sessionId);
      const contextSummary = buildContextSummary(history);
      // A message addressed to a companion by name skips the planner.
      planResult = detectAddressedCompanion(message) ? null : await callKlimtPlanner(history, message, contextSummary);
    } catch (err) {
      // A JSON parse error message quotes part of the text it failed on, so log fixed text for it.
      console.error('[Plan] Error:', err instanceof SyntaxError ? 'planner reply was not valid JSON' : err.message);
    }
    if (planResult && planResult.multi) {
      res.end(JSON.stringify({
        multi: true,
        foundation: planResult.foundation,
        sequence: planResult.sequence,
        synthesis_prompt: planResult.synthesis_prompt,
      }));
      return;
    }
    // Fail-open / single-specialist — identical shape to /api/handoff.
    const handoffResult = await resolveHandoff(sessionId, message);
    res.end(JSON.stringify({ multi: false, ...handoffResult }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sequence/step') {
    const { sessionId, companion, instruction, context } = await readJsonBody(req);
    if (!sessionId || !companion || !instruction) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId, companion and instruction are required' }));
      return;
    }
    if (companion === 'auren' && isRateLimited(req, 'image', RATE_LIMIT_IMAGE)) {
      sendTooManyRequests(res);
      return;
    }
    const ctxArray = Array.isArray(context) ? context : [];
    const sequenceContext = buildSequenceContextBlock(ctxArray, instruction);

    let history = [];
    try {
      history = await getContextEntries(sessionId);
    } catch (err) {
      console.error('[Sequence] getContextEntries failed:', err.message);
    }

    const responseStart = Date.now();
    let result;
    try {
      if (companion === 'klimt') {
        const synthesisSystemPrompt = `${sequenceContext}\n\n${KLIMT_SYNTHESIS_SYSTEM_PROMPT}`;
        const reply = await callKlimt(history, instruction, synthesisSystemPrompt);
        result = { reply, companion: 'klimt' };
      } else if (companion === 'tavily') {
        result = await callTavily(history, instruction, 'basic', sequenceContext);
      } else if (companion === 'nebius') {
        result = await callNebius(history, instruction, sequenceContext);
      } else if (companion === 'edison') {
        result = await callEdison(history, instruction, sequenceContext);
      } else if (companion === 'auren') {
        result = await callAuren(history, instruction, sequenceContext);
      } else {
        result = { reply: null, substituteKlimt: true, companion, failedCompanion: companion };
      }
    } catch (err) {
      // Last-resort safety net — fail-open, the sequence never aborts.
      console.error(`[Sequence] ${companion} dispatch failed unexpectedly:`, err.message);
      result = { reply: null, substituteKlimt: true, companion, failedCompanion: companion };
    }

    let { reply, sources, imageUrl, substituteKlimt, failedCompanion, failureReason } = result;
    let finalCompanion = companion;
    if (substituteKlimt) {
      finalCompanion = 'klimt';
      try {
        reply = await callKlimtSequenceSubstitute(history, instruction, failedCompanion, sequenceContext);
      } catch (err) {
        console.error('[Sequence] Klimt substitute failed:', err.message);
        reply = `${failedCompanion.charAt(0).toUpperCase() + failedCompanion.slice(1)} is unavailable right now — moving on.`;
      }
    }
    if (reply === undefined || reply === null) {
      reply = 'Something went wrong on this step. Moving on.';
    }
    const responseMs = Date.now() - responseStart;

    res.end(JSON.stringify({
      companion: finalCompanion,
      reply,
      sources,
      imageUrl,
      substituteKlimt: substituteKlimt || undefined,
      failedCompanion,
      failureReason,
      meta: { response_ms: responseMs },
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/message') {
    const { sessionId, message, companion: companionOverride, depth: depthOverride } = await readJsonBody(req);
    if (!sessionId || !message) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId and message are required' }));
      return;
    }
    // A companion may already be classified by a prior /api/handoff call —
    // skip re-classification and use it directly when present.
    const intent = companionOverride
      ? {
          companion: companionOverride,
          depth: depthOverride,
          label: INTENT_LABEL_BY_COMPANION[companionOverride] ?? 'general',
          reason: 'pre-classified by client (via /api/handoff)',
        }
      : classifyIntent(message);
    console.log(`[intent] -> ${intent.companion} (${intent.reason})`);
    if (intent.companion === 'auren' && isRateLimited(req, 'image', RATE_LIMIT_IMAGE)) {
      sendTooManyRequests(res);
      return;
    }

    const supabaseReadStart = Date.now();
    const history = await getContextEntries(sessionId);
    const supabaseReadMs = Date.now() - supabaseReadStart;
    await appendContextEntry(sessionId, intent.companion, 'user', message);

    let reply;
    let sources;
    let imageUrl;
    let substituteKlimt = false;
    let failedCompanion;
    let failureReason;
    const responseStart = Date.now();
    try {
      let result;
      if (intent.companion === 'tavily') {
        // The client's pre-classified override carries no recency flag, so fall back to re-classifying.
        result = await callTavily(history, message, intent.depth, '', Boolean(intent.recency ?? classifyIntent(message).recency));
      } else if (intent.companion === 'nebius') {
        result = await callNebius(history, message);
      } else if (intent.companion === 'edison') {
        result = await callEdison(history, message);
      } else if (intent.companion === 'auren') {
        result = await callAuren(history, message);
      } else {
        reply = await callKlimt(history, message);
      }
      if (result) {
        if (result.substituteKlimt) {
          substituteKlimt = true;
          failedCompanion = result.failedCompanion;
          failureReason = result.failureReason;
        } else {
          reply = result.reply;
          sources = result.sources;
          imageUrl = result.imageUrl;
        }
      }
    } catch (err) {
      // Last-resort safety net — specialist functions fail open internally
      // now, so this should rarely fire, but dispatch must never be blocked.
      // The browser can send any companion name, so only print the five known ones.
      const loggedCompanion = Object.hasOwn(INTENT_LABEL_BY_COMPANION, intent.companion) ? intent.companion : 'unknown';
      console.error(`${loggedCompanion} dispatch failed unexpectedly:`, err.message);
      substituteKlimt = true;
      failedCompanion = intent.companion;
    }

    if (substituteKlimt) {
      intent.companion = 'klimt';
      try {
        reply = await callKlimtSubstitute(history, message, failedCompanion);
      } catch (err) {
        console.error('Klimt substitute call failed:', err.message);
        reply = 'Something went wrong on my end. Please try again.';
      }
    }
    if (!reply || !reply.trim()) {
      reply = 'Something went wrong on my end. Please try again.';
    }
    const responseMs = Date.now() - responseStart;

    const assistantEntry = await appendContextEntry(
      sessionId,
      intent.companion,
      'assistant',
      reply,
      imageUrl ? { imageUrl } : {}
    );
    // history was fetched before this turn's user+assistant entries were written.
    const contextCount = history.length + 2;
    res.end(JSON.stringify({
      companion: intent.companion,
      reply,
      sources,
      imageUrl,
      substituteKlimt: substituteKlimt || undefined,
      failedCompanion,
      failureReason,
      entry: assistantEntry,
      meta: {
        supabase_read_ms: supabaseReadMs,
        response_ms: responseMs,
        context_count: contextCount,
        intent: intent.label ?? 'general',
        companion: intent.companion,
      },
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tts') {
    const { text, voiceId } = await readJsonBody(req);
    if (!text || !voiceId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'text and voiceId are required' }));
      return;
    }
    if (!Object.values(VOICES).includes(voiceId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'unknown voice' }));
      return;
    }
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text: stripMarkdown(extractTtsText(text)), model_id: 'eleven_multilingual_v2' }),
      }
    );
    if (!ttsRes.ok) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: `TTS failed: ${ttsRes.status}` }));
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.end(Buffer.from(await ttsRes.arrayBuffer()));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
}

// Only the page, its script and stylesheet, and the assets folder are public.
// Everything else in the project folder (settings, server code, .git) is not.
const PUBLIC_FILES = new Set(['/', '/index.html', '/app.js', '/style.css']);

function serveStatic(req, res, pathname) {
  const safePath = join(ROOT, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!safePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  const isPublic = PUBLIC_FILES.has(pathname) || pathname.startsWith('/assets/');
  if (!isPublic || pathname.split('/').some((part) => part.startsWith('.'))) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  readFile(safePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', MIME_TYPES[extname(safePath)] || 'application/octet-stream');
    res.end(data);
  });
}

// One log line per /api request, written once when the response closes. It
// holds only the time, method, route name (session IDs replaced by :id),
// status and client address. Never headers, message text, response bodies,
// provider addresses or keys. Text that came from the client is cleaned and
// shortened first.
function logApiRequest(req, res, url) {
  res.once('close', () => {
    const route = url.pathname
      .replace(/^\/api\/session\/[^/]+\//, '/api/session/:id/')
      .replace(/[^\w/:.-]/g, '_')
      .slice(0, 80);
    const client = clientAddress(req).replace(/[^\w:.-]/g, '?').slice(0, 64);
    const method = String(req.method).replace(/[^A-Z]/g, '?').slice(0, 10);
    const status = res.writableFinished ? res.statusCode : 'aborted';
    console.log(`${new Date().toISOString()} ${method} ${route} ${status} ${client}`);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    logApiRequest(req, res, url);
    handleApi(req, res, url).catch((err) => {
      // A JSON parse error message quotes part of the text it failed on, so log fixed text for it.
      console.error('[Server] Unhandled API error:', err instanceof SyntaxError ? 'invalid JSON body' : err.message);
      const tooLarge = err.statusCode === 413;
      res.statusCode = tooLarge ? 413 : 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: tooLarge ? 'request too large' : 'Internal error' }));
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Crack On server running at http://localhost:${PORT}`);
});
