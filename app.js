// Crack On — client. Handles session bootstrap, the Klimt chat loop, and
// ElevenLabs voice playback for P2.

// Access code: when the server asks for one, it is kept for this tab only and
// sent with every /api/ request. With no code stored, nothing changes.
const ACCESS_CODE_STORAGE_KEY = 'crackon_access_code';

function readAccessCode() {
  try {
    return sessionStorage.getItem(ACCESS_CODE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function storeAccessCode(code) {
  try {
    sessionStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
  } catch {
    // Storage unavailable: the code is simply asked for again next time.
  }
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const path = typeof input === 'string' ? input : input?.url ?? '';
  const code = readAccessCode();
  if (code && path.startsWith('/api/')) {
    const headers = new Headers(init.headers);
    headers.set('x-access-code', code);
    return nativeFetch(input, { ...init, headers });
  }
  return nativeFetch(input, init);
};

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
  tavily: { name: 'Tavily', voice: 'Maya' },
  nebius: { name: 'Nebius', voice: 'Steve' },
  auren: { name: 'Auren', voice: 'Guy' },
  edison: { name: 'Edison', voice: '—' },
};
const COMPANION_NAMES = Object.fromEntries(
  Object.entries(COMPANION_META).map(([key, meta]) => [key, meta.name])
);

// Per-companion voice mute toggle, controlled by the Audio Control Panel in
// the sidebar — gates every TTS call site (see playVoice() call sites).
const voiceState = {
  klimt: true,
  auren: true,
  tavily: true,
  nebius: true,
  edison: true,
};

// Provider/model family shown in Under the Hood hood lines, e.g. "Klimt (Claude Sonnet)".
const COMPANION_ROLES = {
  klimt: 'Claude Sonnet',
  auren: 'OpenAI GPT',
  tavily: 'Tavily Search',
  nebius: 'Qwen on Token Factory',
  edison: 'NVIDIA Nemotron',
};

// Short provider label used only in the "Routing to:" hood line.
const COMPANION_PROVIDERS = {
  klimt: 'Anthropic',
  tavily: 'Tavily API',
  nebius: 'Nebius Token Factory',
  auren: 'OpenAI',
  edison: 'NVIDIA NIM',
};

// Use wherever a companion name appears in a hood line — never on timing/metric lines.
function companionLabel(companion) {
  const role = COMPANION_ROLES[companion] || companion;
  return `${companion.charAt(0).toUpperCase() + companion.slice(1)} (${role})`;
}

// Unavailable line — reason is a short server code (e.g. "timeout", "http_503").
function unavailableLine(failedCompanion, failureReason) {
  return `→ ${companionLabel(failedCompanion)} unavailable (${failureReason || 'error'}), ${companionLabel('klimt')} covering`;
}

// Mirrors classifyIntent() in server.js — used only for an optimistic UI
// update the moment a message is sent. The server remains the source of
// truth for actual dispatch/fallback.
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
// Edison owns deep technical analysis/architecture; a stock/market query
// always wins so "nvidia" never bleeds NVIDIA stock-price questions to Edison.
const EDISON_KEYWORDS = [
  'architecture', 'analyse', 'analyze', 'deep dive', 'technical analysis',
  'how does it work', 'internals', 'benchmark', 'research', 'paper',
  'engineering', 'system design', 'in depth', 'explain technically',
  'transformer', 'attention mechanism', 'training', 'fine-tuning',
  'inference', 'gpu', 'cuda', 'nvidia', 'hardware',
];
const STOCK_MARKET_KEYWORDS = ['stock', 'price', 'shares', 'market cap'];

// Mirrors detectAddressedCompanion() in server.js — must be kept in sync.
function detectAddressedCompanion(message) {
  const match = /^\s*(edison|tavily|nebius)\s*[,:;\-–—]/i.exec(message);
  return match ? match[1].toLowerCase() : null;
}

function guessIntent(message) {
  const addressed = detectAddressedCompanion(message); if (addressed) return addressed;
  const text = message.toLowerCase();
  if (IMAGE_GENERATION_KEYWORDS.some((kw) => text.includes(kw))) return 'auren';
  const isStockQuery = STOCK_MARKET_KEYWORDS.some((kw) => text.includes(kw));
  const isCurrentEventsQuery = CURRENT_EVENTS_KEYWORDS.some((kw) => text.includes(kw));
  if (OPEN_SOURCE_COMPUTE_KEYWORDS.some((kw) => text.includes(kw))) return 'nebius';
  if (!isStockQuery && !isCurrentEventsQuery && EDISON_KEYWORDS.some((kw) => text.includes(kw))) return 'edison';
  if (CITATION_KEYWORDS.some((kw) => text.includes(kw)) || isCurrentEventsQuery) return 'tavily';
  return 'klimt';
}

let config = null;
let sessionId = null;

const INTENT_LABELS = {
  klimt: 'general',
  tavily: 'citation_required',
  nebius: 'open_source_compute',
  auren: 'image_generation',
  edison: 'deep_technical_analysis',
};

// Real technical identifiers shown in the Under the Hood panel — judges
// should see what's actually running, not just the companion nickname.
// Default playback pace per companion, multiplied by the speed slider.
// Companions not listed here fall back to 1.
const COMPANION_SPEED = { tavily: 1.25 };

const COMPANION_MODEL_LABELS = {
  klimt: 'claude-sonnet-5-5 (Anthropic)',
  tavily: 'Tavily Search API',
  nebius: 'Qwen/Qwen3-30B-A3B (Nebius Token Factory)',
  auren: 'gpt-image-1 / gpt-5.6-sol (OpenAI)',
  edison: 'nvidia/nemotron-3.5-lightning-30b-a3b (NVIDIA NIM)',
};

const sidebarEl = document.getElementById('sidebar');
const sidebarCollapseBtnEl = document.getElementById('sidebar-collapse-btn');
const sidebarExpandBtnEl = document.getElementById('sidebar-expand-btn');
const hoodLiveEl = document.getElementById('hood-live');
const statDispatchesEl = document.getElementById('stat-dispatches');
const statCompanionsEl = document.getElementById('stat-companions');
const statContextEl = document.getElementById('stat-context');
const statTimeEl = document.getElementById('stat-time');
const statCostEl = document.getElementById('stat-cost');

const sessionStats = { dispatches: 0, companions: new Set(['klimt']), contextEntries: 0 };
// RBT story is about human time, not raw API cost — see recalibration note.
const MINUTES_SAVED_PER_DISPATCH = 7.5;
const COST_SAVED_PER_DISPATCH = 1.5;

function addHoodLine(text, extraClass = '') {
  if (!hoodLiveEl) return;
  const line = document.createElement('div');
  line.className = `hood-line ${extraClass}`.trim();
  line.textContent = text;
  hoodLiveEl.appendChild(line);
  hoodLiveEl.scrollTop = hoodLiveEl.scrollHeight;
  requestAnimationFrame(() => line.classList.add('visible'));
  return line;
}

function runHoodSequence(message, guessedCompanion) {
  if (!hoodLiveEl) return;
  hoodLiveEl.innerHTML = '';
  addHoodLine(`\u2192 Input: ${message.slice(0, 40)}`);
  addHoodLine(`\u2192 ${companionLabel('klimt')} classified intent: ${INTENT_LABELS[guessedCompanion] ?? 'general'}`);
  addHoodLine(`\u2192 Routing to: ${companionLabel(guessedCompanion)}`, `companion-${guessedCompanion} pulse`);
  if (guessedCompanion !== 'klimt') {
    addHoodLine(`\u2192 ${companionLabel('klimt')} \u2192 ${companionLabel(guessedCompanion)} handoff`, 'companion-klimt pulse');
  }
}

function flashStat(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function updateSessionStats(companion, contextCount) {
  sessionStats.dispatches += 1;
  sessionStats.companions.add(companion);
  sessionStats.contextEntries = contextCount;

  if (statDispatchesEl) statDispatchesEl.textContent = sessionStats.dispatches;
  if (statCompanionsEl) statCompanionsEl.textContent = [...sessionStats.companions].map((c) => COMPANION_MODEL_LABELS[c] ?? c).join(', ');
  if (statContextEl) statContextEl.textContent = sessionStats.contextEntries;
  if (statTimeEl) statTimeEl.textContent = `${(sessionStats.dispatches * MINUTES_SAVED_PER_DISPATCH).toFixed(1)} mins`;
  if (statCostEl) statCostEl.textContent = `$${(sessionStats.dispatches * COST_SAVED_PER_DISPATCH).toFixed(2)}`;
  for (const el of [statDispatchesEl, statCompanionsEl, statContextEl, statTimeEl, statCostEl]) flashStat(el);
}

function completeHoodSequence(meta, companion) {
  if (!meta || !hoodLiveEl) return;
  let delay = 150;
  setTimeout(() => addHoodLine(`\u2192 Supabase read: ${meta.supabase_read_ms}ms`), delay);
  delay += 250;
  setTimeout(() => addHoodLine(`\u2192 ${companionLabel(companion)} response: ${(meta.response_ms / 1000).toFixed(1)}s`), delay);
  delay += 250;
  setTimeout(() => addHoodLine(`\u2192 Context entries: ${meta.context_count}`), delay);
  delay += 250;
  setTimeout(() => {
    addHoodLine(`\u2192 Returning to: ${companionLabel('klimt')}`, 'companion-klimt pulse');
    updateSessionStats(companion, meta.context_count);
  }, delay);
}

sidebarCollapseBtnEl?.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
});

sidebarExpandBtnEl?.addEventListener('click', () => {
  sidebarEl.classList.remove('collapsed');
});

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

// Scrolls so the user's most recent question sits at the top of the visible
// chat area (with the thread's top padding as a gap), keeping the reply below
// it. Falls back to the bottom when there is no user message yet.
function scrollToLatestQuestion() {
  const questions = threadEl.querySelectorAll('.message-user');
  const question = questions[questions.length - 1];
  if (!question) {
    threadEl.scrollTop = threadEl.scrollHeight;
    return;
  }
  const topPadding = parseFloat(getComputedStyle(threadEl).paddingTop) || 0;
  threadEl.scrollTop +=
    question.getBoundingClientRect().top - threadEl.getBoundingClientRect().top - topPadding;
}

function renderMessage(companion, role, content, sources, imageUrl, isLive = true) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message-${role}${role === 'assistant' ? ` companion-${companion}` : ''}`;

  const header = document.createElement('div');
  header.className = 'message-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'message-header-left';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'assistant' ? (COMPANION_NAMES[companion] ?? companion) : 'You';
  headerLeft.appendChild(meta);

  const headerRight = document.createElement('div');
  headerRight.className = 'message-header-right';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(content));
  headerRight.appendChild(copyBtn);

  header.append(headerLeft, headerRight);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.innerHTML = renderMarkdown(content);

  wrapper.append(header, body);

  if (imageUrl) {
    const figure = document.createElement('figure');
    figure.className = 'generated-image-figure';

    const link = document.createElement('a');
    link.href = imageUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Open full size';

    const img = document.createElement('img');
    img.className = 'generated-image';
    img.src = imageUrl;
    img.alt = content;
    // The image's height is unknown until it loads, so scroll again once it has.
    img.addEventListener('load', () => {
      threadEl.scrollTop = threadEl.scrollHeight;
    });
    link.appendChild(img);

    const downloadBtn = document.createElement('a');
    downloadBtn.className = 'download-image-btn';
    downloadBtn.href = imageUrl;
    downloadBtn.download = `crack-on-${Date.now()}.png`;
    downloadBtn.title = 'Download image';
    downloadBtn.textContent = '⬇';

    figure.append(link, downloadBtn);
    wrapper.appendChild(figure);
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
  // Live messages anchor on the latest question; history replay on resume
  // keeps scrolling to the bottom.
  if (isLive) {
    scrollToLatestQuestion();
  } else {
    threadEl.scrollTop = threadEl.scrollHeight;
  }
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
  scrollToLatestQuestion();
  return wrapper;
}

function setComposerDisabled(disabled) {
  inputEl.disabled = disabled;
  sendBtnEl.disabled = disabled;
  micBtnEl.disabled = disabled;
}

async function playVoice(text, voiceId, token, onDone, companion) {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId }),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    const blob = await res.blob();
    // A newer dispatch may have started while this TTS request was in
    // flight — drop it so voices never bleed into each other.
    if (token !== currentAudioToken) return;
    voicePlayerEl.src = URL.createObjectURL(blob);
    speakingIndicatorEl.hidden = false;
    stopAudioBtnEl.hidden = false;
    voicePlayerEl.playbackRate = (COMPANION_SPEED[companion] ?? 1) * parseFloat(voiceSpeedSliderEl.value);
    await voicePlayerEl.play();
    voicePlayerEl.onended = () => {
      speakingIndicatorEl.hidden = true;
      stopAudioBtnEl.hidden = true;
      // Status only returns home once this companion has actually finished
      // speaking, not the moment playback starts.
      if (token === currentAudioToken) onDone?.();
    };
  } catch (err) {
    // Graceful fallback — text has already rendered, voice is optional.
    speakingIndicatorEl.hidden = true;
    stopAudioBtnEl.hidden = true;
    console.warn('Voice playback unavailable:', err.message);
    if (token === currentAudioToken) onDone?.();
  }
}

let currentAudioToken = 0;
// Set only while executeSequence() is awaiting a step's TTS completion — lets
// the manual stop button unblock that await immediately instead of hanging,
// without also aborting the rest of the sequence (only playback stops).
let pendingSequenceAudioResolve = null;

// Edison's full reply renders on screen but only the intro is spoken, so
// voice playback doesn't drag on for a long technical answer. Extends past
// the first sentence if it's too short (e.g. a bare "Hey there!") so the
// intro is always a meaningful lead-in, not just a greeting.
function getEdisonSpokenText(fullReply) {
  // Prefer the opening paragraph that precedes the first heading or bullet,
  // so a reply that starts with a title and a list isn't spoken from its
  // first bullet. With no such paragraph, fall back to the whole reply.
  const structureMatch = fullReply.match(/^[ \t]*(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t])/m);
  const lead = structureMatch ? fullReply.slice(0, structureMatch.index).trim() : fullReply;
  const source = lead || fullReply;

  // A short reply (no heading/bullet, at most 400 characters and 3 sentences)
  // is spoken in full, with no "read the following" line.
  const trimmedReply = fullReply.trim();
  if (!structureMatch && trimmedReply.length <= 400 && (trimmedReply.match(/[^.!?]*[.!?]+/g) || []).length <= 3) {
    return trimmedReply;
  }

  const sentences = source.match(/[^.!?]*[.!?]+/g) || [];

  let intro = '';

  if (lead) {
    // Opening paragraph: up to 2 sentences within ~300 characters. The first
    // sentence is always spoken in full; a second is added only if it fits.
    const MAX_INTRO_SENTENCES = 2;
    const MAX_INTRO_CHARS = 300;
    for (const sentence of sentences.slice(0, MAX_INTRO_SENTENCES)) {
      const trimmed = sentence.trim();
      const candidate = intro ? `${intro} ${trimmed}` : trimmed;
      if (intro && candidate.length > MAX_INTRO_CHARS) break;
      intro = candidate;
    }
  } else {
    // No opening paragraph — keep the original 80-character lead-in rule.
    let charCount = 0;
    for (const sentence of sentences) {
      intro += sentence.trim() + ' ';
      charCount += sentence.trim().length;
      if (charCount >= 80) break;
    }
  }

  intro = intro.trim();

  if (!intro) intro = source.substring(0, 200).trim();

  return `${intro} Please read the following for further details.`;
}

// Tavily replies contain currency/percentages/URLs that ElevenLabs reads
// literally (garbled) unless spelled out as natural speech first.
function formatTavilyForSpeech(text) {
  return text
    // Currency — $225.43 → "225 dollars and 43 cents"
    .replace(/\$(\d+)\.(\d{2})/g, (_, dollars, cents) =>
      `${dollars} dollars and ${Number(cents)} cents`)
    // Currency no decimal — $225 → "225 dollars"
    .replace(/\$(\d+)/g, (_, n) => `${n} dollars`)
    // EUR — 9.498 EUR → "9 euros and 50 cents"
    .replace(/(\d+)\.(\d+)\s*EUR/gi, (_, euros, cents) =>
      `${euros} euros and ${Math.round(Number('0.' + cents) * 100)} cents`)
    // CAD — 2.04 CAD → "2 Canadian dollars and 4 cents"
    .replace(/(\d+)\.(\d{2})\s*CAD/gi, (_, dollars, cents) =>
      `${dollars} Canadian dollars and ${Number(cents)} cents`)
    // Percentages — 133.53% → "133 point 53 percent"
    .replace(/(\d+)\.(\d+)%/g, (_, whole, dec) =>
      `${whole} point ${dec} percent`)
    // Plain percentages — 15% → "15 percent"
    .replace(/(\d+)%/g, (_, n) => `${n} percent`)
    // Strip markdown links [text](url) → just text — must run BEFORE the
    // raw-URL strip below, otherwise stripping the URL first corrupts the
    // markdown syntax and leaves a dangling "[text](" behind.
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    // Strip any remaining raw URLs entirely
    .replace(/https?:\/\/\S+/g, '')
    // Strip citation brackets [1], [2] etc
    .replace(/\[\d+\]/g, '')
    // Clean up double spaces left by stripping
    .replace(/  +/g, ' ')
    .trim();
}

function stopVoice() {
  voicePlayerEl.pause();
  voicePlayerEl.currentTime = 0;
  speakingIndicatorEl.hidden = true;
  stopAudioBtnEl.hidden = true;
}

stopAudioBtnEl.addEventListener('click', () => {
  currentAudioToken += 1;
  stopVoice();
  setActiveCompanion('klimt');
  if (pendingSequenceAudioResolve) {
    const resolve = pendingSequenceAudioResolve;
    pendingSequenceAudioResolve = null;
    resolve();
  }
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
    sessionIndicatorEl.textContent = 'resumed — context intact';
  } else {
    sessionIndicatorEl.textContent = 'active';
  }
  sessionIndicatorEl.classList.remove('muted');

  for (const entry of history) {
    renderMessage(entry.companion, entry.role, entry.content, undefined, entry.metadata?.imageUrl, false);
  }

  if (isBrandNewSession) {
    await sendOpeningGreeting();
  }
}

async function sendOpeningGreeting() {
  setActiveCompanion('klimt');
  const thinkingEl = renderThinking('klimt');
  setComposerDisabled(true);
  const audioToken = ++currentAudioToken;
  stopVoice();
  try {
    const res = await fetch('/api/greet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) return;
    const { companion, reply } = await res.json();
    renderMessage(companion, 'assistant', reply);
    if (voiceState[companion] && config?.voices?.[companion]) {
      playVoice(reply, config.voices[companion], audioToken, undefined, companion);
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

  // Cancel any companion still speaking the instant a new dispatch starts —
  // no two companions should ever speak simultaneously or bleed together.
  const audioToken = ++currentAudioToken;
  stopVoice();

  // Optimistic UI: populate the Under the Hood panel instantly, before the
  // network round-trip — the server remains the source of truth.
  const guessedCompanion = guessIntent(message);
  setActiveCompanion('klimt');
  setComposerDisabled(true);
  runHoodSequence(message, guessedCompanion);

  // Step 1 — ask Klimt for a plan: a single-specialist pass-through (the
  // existing handoff shape) or a full multi-specialist sequence. Fail-open:
  // any error here falls through to the same single-specialist dispatch.
  let planData = { multi: false, handoff: false };
  try {
    const planRes = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message }),
    });
    if (planRes.ok) planData = await planRes.json();
  } catch (err) {
    console.warn('Plan check unavailable, dispatching directly:', err.message);
  }

  if (planData.multi) {
    await executeSequence(planData);
    return;
  }

  // multi:false carries the exact same shape /api/handoff used to return.
  const handoffData = planData;

  // Step 2 — Klimt only speaks a handoff line for Auren; other specialists
  // route silently (Under the Hood still shows the routing/handoff lines
  // via runHoodSequence/completeHoodSequence regardless — never suppressed).
  if (handoffData.handoff && handoffData.speakHandoff && handoffData.handoffReply) {
    renderMessage('klimt', 'assistant', handoffData.handoffReply);
    if (voiceState.klimt && config?.voices?.klimt) {
      await new Promise((resolve) => playVoice(handoffData.handoffReply, config.voices.klimt, audioToken, resolve, 'klimt'));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  // Step 3 — fire the specialist (or Klimt direct), passing along the
  // already-classified companion so the server skips re-classification.
  const specialistCompanion = handoffData.companion ?? guessedCompanion;
  setActiveCompanion(specialistCompanion);
  const thinkingEl = renderThinking(specialistCompanion);
  if (specialistCompanion === 'auren') {
    addHoodLine(`\u2192 ${companionLabel('auren')} generating image\u2026 (this takes ~15s)`, 'companion-auren pulse');
  }

  let res;
  try {
    res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message,
        companion: handoffData.companion ?? null,
        depth: handoffData.depth ?? null,
      }),
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
  // Voice must always be resolved from the companion the server actually
  // dispatched to (it may differ from guessedCompanion on fallback), never
  // from whichever companion was previously active.
  const { companion, reply, sources, imageUrl, meta, substituteKlimt, failedCompanion, failureReason } = await res.json();
  // Substitution always renders under Klimt's badge — companion already
  // comes back as 'klimt' from the server, but this is made explicit here
  // so badge, TTS gating, and the voice toggle all agree on one source.
  const renderCompanion = substituteKlimt ? 'klimt' : companion;
  if (substituteKlimt && failedCompanion) {
    addHoodLine(unavailableLine(failedCompanion, failureReason), 'companion-klimt pulse');
  }
  setActiveCompanion(renderCompanion);
  renderMessage(renderCompanion, 'assistant', reply, sources, imageUrl);
  completeHoodSequence(meta, renderCompanion);

  // Klimt is always home — but status only returns to him once this
  // companion has actually finished speaking, not when playback starts.
  const returnToKlimt = () => {
    if (audioToken !== currentAudioToken) return;
    setActiveCompanion('klimt');
  };
  if (voiceState[renderCompanion] && config?.voices?.[renderCompanion]) {
    // Edison's full answer renders on screen but only the intro is spoken.
    // A Klimt covering reply gets the same short intro; normal Klimt speech
    // (substituteKlimt unset) still speaks the full reply.
    let spokenText = reply;
    if (substituteKlimt) spokenText = getEdisonSpokenText(reply);
    else if (renderCompanion === 'edison') spokenText = getEdisonSpokenText(reply);
    else if (renderCompanion === 'tavily') spokenText = formatTavilyForSpeech(reply);
    playVoice(spokenText, config.voices[renderCompanion], audioToken, returnToKlimt, renderCompanion);
  } else {
    returnToKlimt();
  }
}

// Handles a full Klimt-planned multi-specialist sequence: foundation (spoken
// immediately) -> each specialist step in order, threading accumulated
// context -> Klimt synthesis (spoken). Composer stays disabled throughout —
// caller (sendMessage) already disabled it before dispatching here.
async function executeSequence(plan) {
  const sequence = Array.isArray(plan.sequence) ? plan.sequence : [];

  // Every step mints its own audio token — stop-audio only needs to abandon
  // whichever clip is currently playing, never the rest of the sequence
  // (composer disable already rules out a newer dispatch superseding this one).
  const speakAndWait = async (text, voiceId, companion) => {
    const speakToken = ++currentAudioToken;
    await new Promise((resolve) => {
      pendingSequenceAudioResolve = resolve;
      playVoice(text, voiceId, speakToken, () => {
        pendingSequenceAudioResolve = null;
        resolve();
      }, companion);
    });
  };

  // Step A — Klimt's foundation, rendered and spoken before any specialist fires.
  setActiveCompanion('klimt');
  renderMessage('klimt', 'assistant', plan.foundation);
  addHoodLine('\u2192 Multi-specialist query \u2014 sequence planned');
  const sequenceNames = sequence.map((step) => COMPANION_NAMES[step.companion] ?? step.companion).join(' \u2192 ');
  addHoodLine(`\u2192 Sequence: ${sequenceNames}${sequenceNames ? ' \u2192 ' : ''}${COMPANION_NAMES.klimt} synthesis`);
  addHoodLine(`\u2192 ${companionLabel('klimt')}: Foundation`, 'companion-klimt pulse');

  if (voiceState.klimt && config?.voices?.klimt) {
    await speakAndWait(plan.foundation, config.voices.klimt, 'klimt');
  }

  // Foundation is the first entry in the accumulated sequence context.
  const context = [{ role: 'klimt_foundation', content: plan.foundation }];

  // Step B — execute each planned step in order, threading accumulated context.
  for (const step of sequence) {
    const label = companionLabel(step.companion);
    addHoodLine(`\u2192 ${label}: Step ${step.step} \u2014 dispatching...`, `companion-${step.companion} pulse`);
    setActiveCompanion(step.companion);
    const thinkingEl = renderThinking(step.companion);
    if (step.companion === 'auren') {
      addHoodLine(`\u2192 ${label} generating image\u2026 (this takes ~15s)`, 'companion-auren pulse');
    }

    const stepStart = Date.now();
    let stepData;
    try {
      const res = await fetch('/api/sequence/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, companion: step.companion, instruction: step.instruction, context }),
      });
      stepData = res.ok
        ? await res.json()
        : { companion: step.companion, reply: null, substituteKlimt: true, failedCompanion: step.companion };
    } catch (err) {
      console.warn(`Sequence step ${step.step} (${step.companion}) failed:`, err.message);
      stepData = { companion: step.companion, reply: null, substituteKlimt: true, failedCompanion: step.companion };
    } finally {
      thinkingEl.remove();
    }
    const stepMs = Date.now() - stepStart;

    const renderCompanion = stepData.substituteKlimt ? 'klimt' : stepData.companion;
    if (stepData.substituteKlimt && stepData.failedCompanion) {
      addHoodLine(unavailableLine(stepData.failedCompanion, stepData.failureReason), 'companion-klimt pulse');
    }
    const reply = stepData.reply ?? 'Something went wrong on this step. Moving on.';
    setActiveCompanion(renderCompanion);
    renderMessage(renderCompanion, 'assistant', reply, stepData.sources, stepData.imageUrl);
    addHoodLine(`\u2192 ${label}: Step ${step.step} \u2014 complete (${(stepMs / 1000).toFixed(1)}s)`);

    context.push({ role: step.companion, content: reply });

    if (voiceState[renderCompanion] && config?.voices?.[renderCompanion]) {
      let spokenText = reply;
      if (stepData.substituteKlimt) spokenText = getEdisonSpokenText(reply);
      else if (renderCompanion === 'edison') spokenText = getEdisonSpokenText(reply);
      else if (renderCompanion === 'tavily') spokenText = formatTavilyForSpeech(reply);
      await speakAndWait(spokenText, config.voices[renderCompanion], renderCompanion);
    }
  }

  // Step C — Klimt synthesis always closes the sequence.
  setActiveCompanion('klimt');
  const synthesisThinkingEl = renderThinking('klimt');
  let synthesisReply;
  try {
    const res = await fetch('/api/sequence/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, companion: 'klimt', instruction: plan.synthesis_prompt, context }),
    });
    const data = res.ok ? await res.json() : null;
    synthesisReply = data?.reply ?? `(error reaching Klimt for synthesis: ${res.statusText})`;
  } catch (err) {
    console.warn('Sequence synthesis failed:', err.message);
    synthesisReply = 'Something went wrong bringing this together. Please try again.';
  } finally {
    synthesisThinkingEl.remove();
  }

  renderMessage('klimt', 'assistant', synthesisReply);
  addHoodLine(`\u2192 ${companionLabel('klimt')}: Synthesis \u2014 sequence complete`, 'companion-klimt pulse');

  if (voiceState.klimt && config?.voices?.klimt) {
    await speakAndWait(synthesisReply, config.voices.klimt, 'klimt');
  }
  setActiveCompanion('klimt');
  setComposerDisabled(false);
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

// Per-companion mute — one delegated listener handles every button in the
// Audio Control Panel's companion list.
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('.companion-mute-btn');
  if (!btn) return;
  const companion = btn.dataset.companion;
  if (!companion || !(companion in voiceState)) return;
  voiceState[companion] = !voiceState[companion];
  btn.textContent = voiceState[companion] ? '🔊' : '🔇';
  btn.dataset.muted = String(!voiceState[companion]);
  const allMuted = Object.values(voiceState).every((v) => !v);
  masterMuteBtnEl.textContent = allMuted ? '🔇 All' : '🔊 All';
  masterMuteBtnEl.classList.toggle('all-muted', allMuted);
});

const masterMuteBtnEl = document.getElementById('master-mute-btn');

masterMuteBtnEl.addEventListener('click', () => {
  const allMuted = Object.values(voiceState).every((v) => !v);
  const newState = allMuted; // if all muted, unmute all; if any live, mute all
  for (const companion in voiceState) {
    voiceState[companion] = newState;
  }
  document.querySelectorAll('.companion-mute-btn').forEach((btn) => {
    btn.textContent = newState ? '🔊' : '🔇';
    btn.dataset.muted = String(!newState);
  });
  masterMuteBtnEl.textContent = newState ? '🔊 All' : '🔇 All';
  masterMuteBtnEl.classList.toggle('all-muted', !newState);
});

const voiceSpeedSliderEl = document.getElementById('voice-speed-slider');
const voiceSpeedLabelEl = document.getElementById('voice-speed-label');

voiceSpeedSliderEl.addEventListener('input', () => {
  const speed = parseFloat(voiceSpeedSliderEl.value);
  voiceSpeedLabelEl.textContent = `${speed.toFixed(2).replace(/\.?0+$/, '')}×`;
  voicePlayerEl.playbackRate = speed;
});

async function init() {
  if (statCompanionsEl) statCompanionsEl.textContent = [...sessionStats.companions].map((c) => COMPANION_MODEL_LABELS[c] ?? c).join(', ');
  let configRes = await fetch('/api/config');
  let rejectedNote = '';
  while (configRes.status === 401) {
    const code = window.prompt(`${rejectedNote}Enter the access code`);
    if (code === null) {
      sessionIndicatorEl.textContent = 'access code required — reload to try again';
      return;
    }
    storeAccessCode(code.trim());
    configRes = await fetch('/api/config');
    rejectedNote = 'That code was not accepted. ';
  }
  config = await configRes.json();
  if (config.edisonModel) COMPANION_MODEL_LABELS.edison = `${config.edisonModel} (NVIDIA NIM)`;
  await bootstrapSession();
}

newSessionBtnEl.addEventListener('click', () => {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  location.reload();
});

init();
