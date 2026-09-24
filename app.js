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

const SESSION_STORAGE_KEY = 'crackon_session_id';
const COMPANION_META = {
  klimt: { name: 'Klimt', voice: 'Cevin' },
  tavily: { name: 'Tavily', voice: 'Jane' },
  nebius: { name: 'Nebius', voice: 'Alex' },
  auren: { name: 'Auren', voice: 'Guy' },
};
const COMPANION_NAMES = Object.fromEntries(
  Object.entries(COMPANION_META).map(([key, meta]) => [key, meta.name])
);

let config = null;
let sessionId = null;

function setActiveCompanion(companion) {
  const meta = COMPANION_META[companion] ?? { name: companion, voice: '—' };
  activeCompanionEl.textContent = meta.name;
  activeCompanionEl.className = `value companion-${companion}`;
  companionDotEl.className = `companion-dot companion-${companion}`;
  voiceLabelEl.textContent = `Voice: ${meta.voice}`;
}

function renderMessage(companion, role, content, sources, imageUrl) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message-${role}${role === 'assistant' ? ` companion-${companion}` : ''}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'assistant' ? (COMPANION_NAMES[companion] ?? companion) : 'You';

  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;

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
    await voicePlayerEl.play();
    voicePlayerEl.onended = () => { speakingIndicatorEl.hidden = true; };
  } catch (err) {
    // Graceful fallback — text has already rendered, voice is optional.
    speakingIndicatorEl.hidden = true;
    console.warn('Voice playback unavailable:', err.message);
  }
}

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
}

async function sendMessage(message) {
  renderMessage(null, 'user', message);
  const res = await fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    renderMessage('klimt', 'assistant', `(error reaching Klimt: ${error})`);
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

async function init() {
  config = await fetch('/api/config').then((res) => res.json());
  await bootstrapSession();
}

init();
