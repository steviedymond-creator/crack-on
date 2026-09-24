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
  'happens. Be warm, concise, and helpful.';

// Keyword-based intent classification only — no PC router logic.
const CITATION_KEYWORDS = ['cite', 'citation', 'source', 'according to', 'reference', 'proof'];
const CURRENT_EVENTS_KEYWORDS = ['today', 'latest', 'recent', 'news', 'this week', 'right now', 'currently', 'happening now'];
const OPEN_SOURCE_COMPUTE_KEYWORDS = ['open source', 'open-source', 'llama', 'nebius', 'oss model'];
const IMAGE_GENERATION_KEYWORDS = ['generate an image', 'draw', 'picture of', 'image of', 'create an image', 'illustration', 'photo of', 'paint'];

function classifyIntent(message) {
  const text = message.toLowerCase();
  if (IMAGE_GENERATION_KEYWORDS.some((kw) => text.includes(kw))) {
    return { companion: 'auren' };
  }
  const openSourceCompute = OPEN_SOURCE_COMPUTE_KEYWORDS.some((kw) => text.includes(kw));
  if (openSourceCompute) {
    return { companion: 'nebius' };
  }
  const citationRequired = CITATION_KEYWORDS.some((kw) => text.includes(kw));
  const currentEvents = CURRENT_EVENTS_KEYWORDS.some((kw) => text.includes(kw));
  if (citationRequired || currentEvents) {
    return { companion: 'tavily', depth: citationRequired ? 'advanced' : 'basic' };
  }
  return { companion: 'klimt' };
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

async function callKlimt(history, userMessage) {
  const messages = history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => ({ role: entry.role, content: entry.content }));
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

async function callNebius(history, userMessage) {
  const messages = history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => ({ role: entry.role, content: entry.content }));
  messages.push({ role: 'user', content: userMessage });

  const res = await fetch('https://api.studio.nebius.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NEBIUS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Nebius call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

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

  const messages = history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => ({ role: entry.role, content: entry.content }));
  messages.push({ role: 'user', content: userMessage });

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
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
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
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

  if (req.method === 'POST' && url.pathname === '/api/message') {
    const { sessionId, message } = await readJsonBody(req);
    if (!sessionId || !message) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId and message are required' }));
      return;
    }
    const intent = classifyIntent(message);
    const history = await getContextEntries(sessionId);
    await appendContextEntry(sessionId, intent.companion, 'user', message);

    let reply;
    let sources;
    let imageUrl;
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

    const assistantEntry = await appendContextEntry(
      sessionId,
      intent.companion,
      'assistant',
      reply,
      imageUrl ? { imageUrl } : {}
    );
    res.end(JSON.stringify({ companion: intent.companion, reply, sources, imageUrl, entry: assistantEntry }));
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
        body: JSON.stringify({ text: stripMarkdown(text), model_id: 'eleven_multilingual_v2' }),
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
