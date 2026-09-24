// Crack On — client. Handles session bootstrap, the Klimt chat loop, and
// ElevenLabs voice playback for P2.

const threadEl = document.getElementById('thread');
const composerEl = document.getElementById('composer');
const inputEl = document.getElementById('composer-input');
const sessionIndicatorEl = document.getElementById('session-indicator');
const voicePlayerEl = document.getElementById('voice-player');
const activeCompanionEl = document.getElementById('active-companion');
const companionDotEl = document.getElementById('companion-dot');
const voiceLabelEl = document.getElementById('voice-label');
const speakingIndicatorEl = document.getElementById('speaking-indicator');
const stopAudioBtnEl = document.getElementById('stop-audio-btn');
const micBtnEl = document.getElementById('mic-btn');
const sendBtnEl = composerEl?.querySelector('button[type="submit"]');
const newSessionBtnEl = document.getElementById('new-session-btn');

const SESSION_STORAGE_KEY = 'crackon_session_id';
const COMPANION_META = {
  klimt: { name: 'Klimt', voice: 'Cevin' },
  tavily: { name: 'Tavily', voice: 'Domi' },
  nebius: { name: 'Nebius', voice: 'Alex' },
  auren: { name: 'Auren', voice: 'Guy' },
};
const COMPANION_NAMES = Object.fromEntries(
  Object.entries(COMPANION_META).map(([key, meta]) => [key, meta.name])
);

// Mirrors classifyIntent() in server.js — used only for an optimistic UI
// update the moment a message is sent. The server remains the source of
// truth for actual dispatch/fallback.
const CITATION_KEYWORDS = ['cite', 'citation', 'source', 'according to', 'reference', 'proof'];
const CURRENT_EVENTS_KEYWORDS = ['today', 'latest', 'recent', 'news', 'this week', 'right now', 'currently', 'happening now'];
const OPEN_SOURCE_COMPUTE_KEYWORDS = ['open source', 'open-source', 'llama', 'nebius', 'oss model'];
const IMAGE_GENERATION_KEYWORDS = ['generate an image', 'draw', 'picture of', 'image of', 'create an image', 'illustration', 'photo of', 'paint'];

function guessIntent(message) {
  const text = message.toLowerCase();
  if (IMAGE_GENERATION_KEYWORDS.some((kw) => text.includes(kw))) return 'auren';
  if (OPEN_SOURCE_COMPUTE_KEYWORDS.some((kw) => text.includes(kw))) return 'nebius';
  if (CITATION_KEYWORDS.some((kw) => text.includes(kw)) || CURRENT_EVENTS_KEYWORDS.some((kw) => text.includes(kw))) return 'tavily';
  return 'klimt';
}

let config = null;
let sessionId = null;

function setActiveCompanion(companion) {
  const meta = COMPANION_META[companion] ?? { name: companion, voice: '—' };
  activeCompanionEl.textContent = meta.name;
  activeCompanionEl.className = `value companion-${companion}`;
  companionDotEl.className = `companion-dot companion-${companion}`;
  voiceLabelEl.textContent = `Voice: ${meta.voice}`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderTableHtml(rows) {
  const cells = rows.map((row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const [header, , ...bodyRows] = cells;
  const thead = `<thead><tr>${header.map((h) => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table class="md-table">${thead}${tbody}</table>`;
}

// Minimal, dependency-free Markdown -> HTML renderer. Escapes HTML first so
// no raw markup from a companion response or user input can ever execute.
function renderMarkdown(raw) {
  const lines = escapeHtml(raw).split('\n');
  const html = [];
  let i = 0;
  let listType = null;
  let inCodeBlock = false;
  let codeBuffer = [];

  const flushList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushList();
      if (!inCodeBlock) { inCodeBlock = true; codeBuffer = []; i++; continue; }
      html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
      inCodeBlock = false;
      i++;
      continue;
    }
    if (inCodeBlock) { codeBuffer.push(line); i++; continue; }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      flushList();
      const tableRows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { tableRows.push(lines[i]); i++; }
      html.push(renderTableHtml(tableRows));
      continue;
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      flushList();
      const level = headerMatch[1].length;
      html.push(`<h${level}>${inlineMarkdown(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flushList();
      html.push('<hr>');
      i++;
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bulletMatch) {
      if (listType !== 'ul') { flushList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>${inlineMarkdown(bulletMatch[1])}</li>`);
      i++;
      continue;
    }

    const numberedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numberedMatch) {
      if (listType !== 'ol') { flushList(); html.push('<ol>'); listType = 'ol'; }
      html.push(`<li>${inlineMarkdown(numberedMatch[1])}</li>`);
      i++;
      continue;
    }

    flushList();

    if (line.trim() === '') { i++; continue; }

    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*[-*_]{3,}\s*$/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    html.push(`<p>${inlineMarkdown(paraLines.join(' '))}</p>`);
  }

  flushList();
  if (inCodeBlock) html.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  return html.join('\n');
}

function renderMessage(companion, role, content, sources, imageUrl) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message-${role}${role === 'assistant' ? ` companion-${companion}` : ''}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'assistant' ? (COMPANION_NAMES[companion] ?? companion) : 'You';

  const body = document.createElement('div');
  body.className = 'message-body';
  body.innerHTML = renderMarkdown(content);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(content));

  wrapper.append(meta, body, copyBtn);

  if (imageUrl) {
    const img = document.createElement('img');
    img.className = 'generated-image';
    img.src = imageUrl;
    img.alt = content;
    wrapper.appendChild(img);
  }

  if (sources?.length) {
    const sourcesEl = document.createElement('ul');
    sourcesEl.className = 'sources';
    for (const source of sources) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title || source.url;
      item.appendChild(link);
      sourcesEl.appendChild(item);
    }
    wrapper.appendChild(sourcesEl);
  }

  threadEl.appendChild(wrapper);
  threadEl.scrollTop = threadEl.scrollHeight;
}

function renderResumeBanner() {
  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML =
    '<strong>Welcome back. I remember where we were.</strong>' +
    '<span>Context intact — no re-briefing needed.</span>';
  threadEl.appendChild(banner);
}

function renderThinking(companion) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message-assistant thinking companion-${companion}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = COMPANION_NAMES[companion] ?? companion;

  const dots = document.createElement('div');
  dots.className = 'thinking-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';

  wrapper.append(meta, dots);
  threadEl.appendChild(wrapper);
  threadEl.scrollTop = threadEl.scrollHeight;
  return wrapper;
}

function setComposerDisabled(disabled) {
  inputEl.disabled = disabled;
  sendBtnEl.disabled = disabled;
  micBtnEl.disabled = disabled;
}

async function playVoice(text, voiceId) {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    const blob = await res.blob();
    voicePlayerEl.src = URL.createObjectURL(blob);
    speakingIndicatorEl.hidden = false;
    stopAudioBtnEl.hidden = false;
    await voicePlayerEl.play();
    voicePlayerEl.onended = () => {
      speakingIndicatorEl.hidden = true;
      stopAudioBtnEl.hidden = true;
    };
  } catch (err) {
    // Graceful fallback — text has already rendered, voice is optional.
    speakingIndicatorEl.hidden = true;
    stopAudioBtnEl.hidden = true;
    console.warn('Voice playback unavailable:', err.message);
  }
}

stopAudioBtnEl.addEventListener('click', () => {
  voicePlayerEl.pause();
  voicePlayerEl.currentTime = 0;
  speakingIndicatorEl.hidden = true;
  stopAudioBtnEl.hidden = true;
});

async function bootstrapSession() {
  sessionId = localStorage.getItem(SESSION_STORAGE_KEY);
  const isReturning = Boolean(sessionId);
  if (!sessionId) {
    const res = await fetch('/api/session', { method: 'POST' });
    const session = await res.json();
    sessionId = session.id;
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }

  const historyRes = await fetch(`/api/session/${sessionId}/context`);
  const history = await historyRes.json();

  const isBrandNewSession = !isReturning && history.length === 0;

  if (isReturning && history.length > 0) {
    renderResumeBanner();
    sessionIndicatorEl.textContent = `resumed — context intact (${sessionId.slice(0, 8)})`;
  } else {
    sessionIndicatorEl.textContent = `active (${sessionId.slice(0, 8)})`;
  }
  sessionIndicatorEl.classList.remove('muted');

  for (const entry of history) {
    renderMessage(entry.companion, entry.role, entry.content, undefined, entry.metadata?.imageUrl);
  }

  if (isBrandNewSession) {
    await sendOpeningGreeting();
  }
}

async function sendOpeningGreeting() {
  setActiveCompanion('klimt');
  const thinkingEl = renderThinking('klimt');
  setComposerDisabled(true);
  try {
    const res = await fetch('/api/greet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return;
    const { companion, reply } = await res.json();
    renderMessage(companion, 'assistant', reply);
    if (config?.voices?.[companion]) {
      playVoice(reply, config.voices[companion]);
    }
  } catch (err) {
    console.warn('Opening greeting unavailable:', err.message);
  } finally {
    thinkingEl.remove();
    setComposerDisabled(false);
  }
}

async function sendMessage(message) {
  renderMessage(null, 'user', message);

  // Optimistic UI: switch the status panel the instant we dispatch, before
  // the response arrives — the server may still fall back to Klimt.
  const guessedCompanion = guessIntent(message);
  setActiveCompanion(guessedCompanion);
  const thinkingEl = renderThinking(guessedCompanion);
  setComposerDisabled(true);

  let res;
  try {
    res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message }),
    });
  } finally {
    thinkingEl.remove();
    setComposerDisabled(false);
  }

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    renderMessage('klimt', 'assistant', `(error reaching Klimt: ${error})`);
    setActiveCompanion('klimt');
    return;
  }
  const { companion, reply, sources, imageUrl } = await res.json();
  setActiveCompanion(companion);
  renderMessage(companion, 'assistant', reply, sources, imageUrl);
  if (config?.voices?.[companion]) {
    playVoice(reply, config.voices[companion]);
  }
  // Klimt is always home — control returns after every specialist dispatch.
  setActiveCompanion('klimt');
}

composerEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;
  inputEl.value = '';
  sendMessage(message);
});

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognitionCtor) {
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.addEventListener('result', (event) => {
    const transcript = event.results[0][0].transcript.trim();
    if (transcript) {
      inputEl.value = transcript;
      composerEl.requestSubmit();
    }
  });

  recognition.addEventListener('end', () => micBtnEl.classList.remove('listening'));
  recognition.addEventListener('error', () => micBtnEl.classList.remove('listening'));

  micBtnEl.addEventListener('click', () => {
    micBtnEl.classList.add('listening');
    recognition.start();
  });
} else {
  // Graceful fallback — hide the mic button if the browser has no speech API.
  micBtnEl.hidden = true;
}

async function init() {
  config = await fetch('/api/config').then((res) => res.json());
  await bootstrapSession();
}

newSessionBtnEl.addEventListener('click', () => {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  location.reload();
});

init();
