// Crack On backend — serves the static frontend and proxies companion/TTS
// calls so secret API keys never reach the browser.
import { createServer } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function loadEnv(path) {
  const env = {};
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv(join(ROOT, '.env'));
const PORT = process.env.PORT || 3000;

const KLIMT_SYSTEM_PROMPT =
  'You are Klimt, the orchestrating anchor companion for Crack On. ' +
  'You keep the conversation thread intact for the user no matter what ' +
  'happens. Be warm, concise, and helpful. ' +
  'You are the anchor companion in a multi-companion system. When you see ' +
  'messages attributed to [Tavily], [Nebius], or [Auren] in the ' +
  'conversation history, these are your specialist companions who handled ' +
  'those queries. You are aware of everything they said and can reference ' +
  'their responses. You did not answer those questions yourself — your ' +
  'specialists did. Be honest about this.';

// Keyword-based intent classification only — no PC router logic.
// Tavily is the fast, reliable general information specialist (citation +
// current-events triggers). Nebius fires only on narrow open-source
// compute keywords so it stays rare during live demos (it is much slower).
const CITATION_KEYWORDS = ['cite', 'citation', 'source', 'according to', 'reference', 'proof'];
const CURRENT_EVENTS_KEYWORDS = ['today', 'latest', 'recent', 'news', 'this week', 'right now', 'currently', 'happening now', 'stock price'];
const OPEN_SOURCE_COMPUTE_KEYWORDS = [
  'open source model', 'llama', 'qwen', 'neural network weights',
  'transformer architecture', 'fine-tuning', 'gpu inference',
];
const IMAGE_GENERATION_KEYWORDS = ['generate an image', 'draw', 'picture of', 'image of', 'create an image', 'illustration', 'photo of', 'paint'];

function classifyIntent(message) {
  const text = message.toLowerCase();

  const imageMatch = IMAGE_GENERATION_KEYWORDS.find((kw) => text.includes(kw));
  if (imageMatch) {
    return { companion: 'auren', label: 'image_generation', reason: `matched image keyword "${imageMatch}"` };
  }

  const openSourceMatch = OPEN_SOURCE_COMPUTE_KEYWORDS.find((kw) => text.includes(kw));
  if (openSourceMatch) {
    return { companion: 'nebius', label: 'open_source_compute', reason: `matched open-source-compute keyword "${openSourceMatch}"` };
  }

  const citationMatch = CITATION_KEYWORDS.find((kw) => text.includes(kw));
  const currentEventsMatch = CURRENT_EVENTS_KEYWORDS.find((kw) => text.includes(kw));
  if (citationMatch || currentEventsMatch) {
    return {
      companion: 'tavily',
      depth: citationMatch ? 'advanced' : 'basic',
      label: 'citation_required',
      reason: `matched ${citationMatch ? 'citation' : 'current-events'} keyword "${citationMatch ?? currentEventsMatch}"`,
    };
  }

  return { companion: 'klimt', label: 'general', reason: 'no specialist keyword matched (default)' };
}

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
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function createSession() {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ surface: 'web', user_id: 'anonymous' }),
  });
  if (!res.ok) throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
  const [session] = await res.json();
  return session;
}

async function getContextEntries(sessionId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/context_entries?session_id=eq.${sessionId}&select=*&order=created_at.asc`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`getContextEntries failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function appendContextEntry(sessionId, companion, role, content, metadata = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/context_entries`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ session_id: sessionId, companion, role, content, metadata }),
  });
  if (!res.ok) throw new Error(`appendContextEntry failed: ${res.status} ${await res.text()}`);
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

async function callKlimt(history, userMessage) {
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
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: KLIMT_SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.map((block) => block.text ?? '').join('');
}

const NEBIUS_SYSTEM_PROMPT =
  'You are Nebius, the open-source compute specialist for Crack On. ' +
  'Respond concisely in plain prose — quality over length, no tables, no ' +
  'headers, minimal formatting. Always end with a "## Summary" section ' +
  'containing 3-5 short bullet points capturing the key takeaways — only ' +
  'that summary will be read aloud via text-to-speech, so it must stand ' +
  'on its own.';

async function callNebius(history, userMessage) {
  const messages = [
    { role: 'system', content: NEBIUS_SYSTEM_PROMPT },
    ...history
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user', content: userMessage },
  ];

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
  if (!res.ok) throw new Error(`Nebius call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
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

async function callAuren(history, userMessage) {
  let imageUrl;
  try {
    const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: userMessage, n: 1, size: '1024x1024' }),
    });
    if (imgRes.ok) {
      const imgData = await imgRes.json();
      const b64 = imgData.data?.[0]?.b64_json;
      imageUrl = b64 ? `data:image/png;base64,${b64}` : undefined;
    } else {
      console.warn(`Auren image generation unavailable: ${imgRes.status} ${await imgRes.text()}`);
    }
  } catch (err) {
    console.warn('Auren image generation failed:', err.message);
  }

  const messages = [
    { role: 'system', content: imageUrl ? AUREN_IMAGE_SUCCESS_SYSTEM_PROMPT : AUREN_IMAGE_FAILURE_SYSTEM_PROMPT },
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
    body: JSON.stringify({ model: 'gpt-5.5', messages }),
  });
  if (!chatRes.ok) throw new Error(`Auren chat call failed: ${chatRes.status} ${await chatRes.text()}`);
  const chatData = await chatRes.json();
  const reply = chatData.choices[0].message.content;
  return { reply, imageUrl };
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

async function callTavily(history, query, depth) {
  const contextSummary = buildContextSummary(history);
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
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: contextualQuery,
      search_depth: depth,
      include_answer: true,
      max_results: 5,
    }),
  });
  if (!res.ok) throw new Error(`Tavily call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const sources = (data.results ?? []).map((r) => ({ title: r.title, url: r.url }));
  const reply = data.answer || 'No grounded answer found for that query.';
  return { reply, sources };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

async function handleApi(req, res, url) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.end(JSON.stringify({
      supabaseUrl: env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
      voices: { klimt: env.ELEVENLABS_VOICE_KLIMT, tavily: env.ELEVENLABS_VOICE_TAVILY, nebius: env.ELEVENLABS_VOICE_NEBIUS, auren: env.ELEVENLABS_VOICE_AUREN },
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

  if (req.method === 'POST' && url.pathname === '/api/message') {
    const { sessionId, message } = await readJsonBody(req);
    if (!sessionId || !message) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId and message are required' }));
      return;
    }
    const intent = classifyIntent(message);
    console.log(`[intent] "${message.slice(0, 80)}" -> ${intent.companion} (${intent.reason})`);

    const supabaseReadStart = Date.now();
    const history = await getContextEntries(sessionId);
    const supabaseReadMs = Date.now() - supabaseReadStart;
    await appendContextEntry(sessionId, intent.companion, 'user', message);

    let reply;
    let sources;
    let imageUrl;
    const responseStart = Date.now();
    try {
      if (intent.companion === 'tavily') {
        ({ reply, sources } = await callTavily(history, message, intent.depth));
      } else if (intent.companion === 'nebius') {
        reply = await callNebius(history, message);
      } else if (intent.companion === 'auren') {
        ({ reply, imageUrl } = await callAuren(history, message));
      } else {
        reply = await callKlimt(history, message);
      }
    } catch (err) {
      // Fail gracefully — Klimt handles the task if a specialist fails.
      console.error(`${intent.companion} dispatch failed, falling back to Klimt:`, err.message);
      intent.companion = 'klimt';
      reply = await callKlimt(history, message);
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

function serveStatic(req, res, pathname) {
  const safePath = join(ROOT, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!safePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
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

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Crack On server running at http://localhost:${PORT}`);
});
