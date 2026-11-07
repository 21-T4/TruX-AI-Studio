import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const MARK = '<span class="mark"><svg viewBox="0 0 32 32"><path d="M9 10h14M16 10v13" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/></svg></span>';

let auth = null;
let user = null;
let models = [];
let me = null;
let fullKey = null;
let chats = [];
let currentId = null;
let streaming = null;
const defaults = { model: 'trux-2.0', system: '', temperature: 1, topP: 0.95, maxTokens: 8192 };
let settings = { ...defaults };

// ---- utilities -----------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Copied');
}

async function token() { return user.getIdToken(); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token(), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

// ---- markdown (safe: everything is escaped first) -------------------------------------------
function md(src) {
  const codes = [];
  src = src.replace(/```([\w+-]*)[^\S\n]*\n([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    codes.push({ lang, code: code.replace(/\n$/, '') });
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  const inline = (text) => {
    let h = esc(text);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    h = h.replace(/\u0000(\d+)\u0000/g, (_m, i) => '<code>' + esc(codes[+i].code) + '</code>');
    return h;
  };
  const block = (c) => '<div class="code"><div class="code-h"><span>' + esc(c.lang || 'text') +
    '</span><button class="copy" data-copy type="button">Copy</button></div><pre><code>' + esc(c.code) + '</code></pre></div>';

  let out = '', list = null, para = [];
  const flush = () => { if (para.length) { out += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'; para = []; } };
  const close = () => { if (list) { out += '</' + list + '>'; list = null; } };

  for (const line of src.split('\n')) {
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flush(); close(); out += block(codes[+m[1]]); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); close(); const n = m[1].length + 1; out += '<h' + n + '>' + inline(m[2]) + '</h' + n + '>'; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); close(); out += '<hr>'; continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flush(); if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += '<li>' + inline(m[1]) + '</li>'; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flush(); if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += '<li>' + inline(m[1]) + '</li>'; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flush(); close(); out += '<blockquote>' + inline(m[1]) + '</blockquote>'; continue; }
    if (!line.trim()) { flush(); close(); continue; }
    close(); para.push(line);
  }
  flush(); close();
  return out;
}

// ---- settings & chats (kept in this browser) -------------------------------------------------
const settingsKey = () => 'trux.settings.v1';
const chatsKey = () => 'trux.chats.v1.' + (user ? user.uid : '');

function loadSettings() {
  try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(settingsKey()) || '{}') }; } catch { settings = { ...defaults }; }
  if (!models.some((m) => m.id === settings.model)) settings.model = (models.find((m) => m.id === 'trux-2.0') || models[0]).id;
}
const saveSettings = () => { try { localStorage.setItem(settingsKey(), JSON.stringify(settings)); } catch {} };

function loadChats() {
  try { chats = JSON.parse(localStorage.getItem(chatsKey()) || '[]'); } catch { chats = []; }
  if (!Array.isArray(chats)) chats = [];
}
const saveChats = () => { try { localStorage.setItem(chatsKey(), JSON.stringify(chats.slice(0, 60))); } catch {} };
const current = () => chats.find((c) => c.id === currentId) || null;

function newChat() {
  if (streaming) return;
  currentId = null;
  renderHistory(); renderThread();
  setView('play'); closeDrawers();
  $('#input').focus();
}

// ---- rendering ---------------------------------------------------------------------------------
function renderHistory() {
  const box = $('#history');
  box.textContent = '';
  if (!chats.length) { const d = document.createElement('div'); d.className = 'h-empty'; d.textContent = 'No chats yet'; box.append(d); return; }
  for (const c of [...chats].sort((a, b) => b.updated - a.updated)) {
    const row = document.createElement('div');
    row.className = 'h-item' + (c.id === currentId ? ' active' : '');
    const open = document.createElement('button');
    open.className = 'open'; open.type = 'button'; open.textContent = c.title;
    open.addEventListener('click', () => { if (streaming) return; currentId = c.id; renderHistory(); renderThread(); setView('play'); closeDrawers(); });
    const del = document.createElement('button');
    del.className = 'del'; del.type = 'button'; del.textContent = '×'; del.title = 'Delete chat';
    del.addEventListener('click', () => {
      if (streaming) return;
      chats = chats.filter((x) => x.id !== c.id);
      if (currentId === c.id) currentId = null;
      saveChats(); renderHistory(); renderThread();
    });
    row.append(open, del); box.append(row);
  }
}

function emptyState() {
  const el = document.createElement('div');
  el.className = 'empty';
  el.innerHTML = '<h2>Hello, <span class="grad"></span></h2><p>What do you want to build with TruX today?</p><div class="sugs"></div>';
  el.querySelector('.grad').textContent = (user.displayName || 'there').split(' ')[0];
  const ideas = ['Explain how transformers work, simply', 'Write a Python script that renames files by date', 'Give me 5 startup ideas for students', 'Review my code for performance problems'];
  for (const idea of ideas) {
    const b = document.createElement('button');
    b.className = 'sug'; b.type = 'button'; b.textContent = idea;
    b.addEventListener('click', () => { $('#input').value = idea; send(); });
    el.querySelector('.sugs').append(b);
  }
  return el;
}

function messageEl(m, index, chat) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  if (m.role === 'user') {
    const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.content; el.append(b);
    return el;
  }
  el.innerHTML = MARK + '<div class="a-body"><div class="md"></div><div class="tail"></div></div>';
  fillAssistant(el, m, index === chat.messages.length - 1);
  return el;
}

function fillAssistant(el, m, isLast) {
  const body = el.querySelector('.md');
  body.innerHTML = m.content ? md(m.content) : (m.error ? '' : '<span class="typing"><i></i><i></i><i></i></span>');
  const tail = el.querySelector('.tail');
  tail.textContent = '';
  if (m.error) { const e = document.createElement('div'); e.className = 'msg-err'; e.textContent = m.error; tail.append(e); }
  if (m.content || m.error) {
    const acts = document.createElement('div'); acts.className = 'acts';
    if (m.content) { const c = document.createElement('button'); c.type = 'button'; c.textContent = 'Copy'; c.addEventListener('click', () => copyText(m.content)); acts.append(c); }
    if (isLast && !streaming) { const r = document.createElement('button'); r.type = 'button'; r.textContent = 'Regenerate'; r.addEventListener('click', regenerate); acts.append(r); }
    tail.append(acts);
  }
}

function renderThread() {
  const thread = $('#thread');
  thread.textContent = '';
  const chat = current();
  $('#topTitle').textContent = chat ? chat.title : 'Playground';
  if (!chat || !chat.messages.length) { thread.append(emptyState()); return; }
  chat.messages.forEach((m, i) => thread.append(messageEl(m, i, chat)));
  thread.scrollTop = thread.scrollHeight;
}

function renderModels() {
  const list = $('#modelList');
  list.textContent = '';
  for (const m of models) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'model' + (m.id === settings.model ? ' sel' : '');
    const name = document.createElement('b'); name.textContent = m.name;
    if (m.dailyLimit) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = m.dailyLimit + '/day free'; name.append(badge); }
    const tag = document.createElement('small'); tag.textContent = m.tagline;
    b.append(name, tag);
    b.addEventListener('click', () => { settings.model = m.id; saveSettings(); renderModels(); renderChip(); closeDrawers(); });
    list.append(b);
  }
}

function renderChip() {
  const m = models.find((x) => x.id === settings.model);
  if (!m) return;
  const used = (me && me.usage && me.usage[m.id.replace(/[^a-z0-9]/g, '_')]) || 0;
  $('#modelChip').textContent = m.name + (m.dailyLimit ? ' · ' + used + '/' + m.dailyLimit + ' today' : '');
}

function renderParams() {
  $('#system').value = settings.system;
  $('#temp').value = settings.temperature; $('#tempO').textContent = Number(settings.temperature).toFixed(2);
  $('#topp').value = settings.topP; $('#toppO').textContent = Number(settings.topP).toFixed(2);
  $('#maxt').value = settings.maxTokens;
}

function renderKeyPage() {
  const origin = location.origin;
  $('#keyText').textContent = fullKey || ((me && me.keyPrefix) ? me.keyPrefix + '••••••••••••••••••••••••' : '');
  $('#copyKey').hidden = !fullKey;
  $('#newKeyBanner').hidden = !fullKey;
  const k = fullKey || 'YOUR_TRUX_KEY';
  $('#curlSample').textContent =
    'curl -N ' + origin + '/v1/chat/completions \\\n' +
    '  -H "Authorization: Bearer ' + k + '" \\\n' +
    '  -H "Content-Type: application/json" \\\n' +
    '  -d \'{"model":"trux-2.0","stream":true,"messages":[{"role":"user","content":"Hello!"}]}\'';
  $('#pySample').textContent =
    'from openai import OpenAI\n\n' +
    'client = OpenAI(base_url="' + origin + '/v1", api_key="' + k + '")\n' +
    'r = client.chat.completions.create(\n' +
    '    model="trux-2.0",\n' +
    '    messages=[{"role": "user", "content": "Hello!"}],\n' +
    ')\n' +
    'print(r.choices[0].message.content)';

  const usage = $('#usage');
  usage.textContent = '';
  for (const m of models) {
    const used = (me && me.usage && me.usage[m.id.replace(/[^a-z0-9]/g, '_')]) || 0;
    const row = document.createElement('div'); row.className = 'u-row';
    const t = document.createElement('div'); t.className = 'u-t';
    const n = document.createElement('span'); n.textContent = m.name;
    const c = document.createElement('span'); c.textContent = used + ' / ' + (m.dailyLimit || '∞');
    t.append(n, c);
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i'); fill.style.width = (m.dailyLimit ? Math.min(100, used / m.dailyLimit * 100) : (used ? 6 : 0)) + '%';
    bar.append(fill); row.append(t, bar); usage.append(row);
  }

  const docs = $('#docModels');
  docs.textContent = '';
  for (const m of models) {
    const row = document.createElement('div'); row.className = 'm-row';
    const a = document.createElement('span'); a.textContent = m.name;
    const b = document.createElement('code'); b.textContent = m.id;
    row.append(a, b); docs.append(row);
  }
}

// ---- navigation ----------------------------------------------------------------------------------
function setView(view) {
  $('#app').dataset.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + view));
  $$('.item').forEach((i) => i.classList.toggle('active', i.dataset.view === view));
  $('#topTitle').textContent = view === 'play' ? (current() ? current().title : 'Playground') : view === 'key' ? 'API key' : 'Docs';
  if (view !== 'play') renderKeyPage();
}
function closeDrawers() { document.body.classList.remove('nav-open', 'params-open'); }

// ---- chatting ------------------------------------------------------------------------------------
function setSending(on) {
  const btn = $('#sendBtn');
  btn.classList.toggle('stop', on);
  btn.innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  btn.setAttribute('aria-label', on ? 'Stop' : 'Send');
}

async function send() {
  if (streaming) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  let chat = current();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: text.replace(/\s+/g, ' ').slice(0, 48), messages: [], updated: Date.now() };
    chats.unshift(chat); currentId = chat.id;
  }
  chat.messages.push({ role: 'user', content: text });
  input.value = ''; autosize();
  await runAssistant(chat);
}

async function regenerate() {
  const chat = current();
  if (!chat || streaming) return;
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
  if (!chat.messages.length) return;
  await runAssistant(chat);
}

async function runAssistant(chat) {
  const history = chat.messages
    .filter((m) => m.content && !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
  const reply = { role: 'assistant', content: '' };
  chat.messages.push(reply);
  chat.updated = Date.now();
  renderHistory(); renderThread();

  const controller = new AbortController();
  streaming = controller;
  setSending(true);
  const el = $('#thread').lastElementChild;
  const thread = $('#thread');
  let pending = false;
  const paint = () => {
    pending = false;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    el.querySelector('.md').innerHTML = md(reply.content);
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
  };

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() },
      body: JSON.stringify({
        model: settings.model, messages: history, system: settings.system,
        temperature: settings.temperature, topP: settings.topP, maxTokens: settings.maxTokens
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'Request failed (' + res.status + ')');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.error) throw new Error(j.error);
        if (j.text) { reply.content += j.text; if (!pending) { pending = true; requestAnimationFrame(paint); } }
        if (j.done && j.quota && me) {
          me.usage = me.usage || {};
          me.usage[settings.model.replace(/[^a-z0-9]/g, '_')] = j.quota.used;
        }
      }
    }
    if (!reply.content) reply.error = 'The model returned an empty reply. Try again.';
  } catch (error) {
    if (error.name !== 'AbortError') reply.error = error.message || 'Something went wrong.';
  } finally {
    streaming = null;
    setSending(false);
    chat.updated = Date.now();
    if (!reply.content && !reply.error) chat.messages.pop();
    saveChats(); renderChip(); renderHistory(); renderThread();
  }
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

// ---- auth flow -----------------------------------------------------------------------------------
function showLoginError(message) { const e = $('#loginErr'); e.textContent = message; e.hidden = !message; }

async function enter() {
  try {
    $('#googleBtn').disabled = true;
    models = (await (await fetch('/api/models')).json()).models;
    me = await api('/api/me');
    fullKey = me.key || null;
  } catch (error) {
    $('#googleBtn').disabled = false;
    showLoginError(error.message || 'Could not load your account.');
    await signOut(auth).catch(() => {});
    return;
  }
  $('#googleBtn').disabled = false;
  showLoginError('');
  loadSettings(); loadChats();
  $('#meName').textContent = me.user.displayName || 'TruX user';
  $('#meMail').textContent = me.user.email;
  const av = $('#avatar');
  if (me.user.photoURL) { av.src = me.user.photoURL; av.referrerPolicy = 'no-referrer'; av.hidden = false; } else av.hidden = true;
  currentId = null;
  renderModels(); renderChip(); renderParams(); renderHistory(); renderThread(); renderKeyPage();
  $('#login').hidden = true; $('#app').hidden = false;
  setView(fullKey ? 'key' : 'play');
}

function leave() {
  me = null; fullKey = null; chats = []; currentId = null;
  if (streaming) streaming.abort();
  $('#app').hidden = true; $('#login').hidden = false;
  closeDrawers();
}

async function login() {
  showLoginError('');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    const code = error && error.code;
    if (code === 'auth/popup-blocked') return signInWithRedirect(auth, provider);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
    if (code === 'auth/unauthorized-domain') {
      return showLoginError('This domain is not authorised in Firebase yet. Add it under Authentication > Settings > Authorized domains.');
    }
    showLoginError('Google sign-in failed. Please try again.');
  }
}

// ---- events --------------------------------------------------------------------------------------
$('#googleBtn').addEventListener('click', login);
$('#signOut').addEventListener('click', () => signOut(auth));
$('#newChat').addEventListener('click', newChat);
$('#openNav').addEventListener('click', () => document.body.classList.add('nav-open'));
$('#openParams').addEventListener('click', () => document.body.classList.add('params-open'));
$('#modelChip').addEventListener('click', () => document.body.classList.add('params-open'));
$('#closeParams').addEventListener('click', closeDrawers);
$('#scrim').addEventListener('click', closeDrawers);
$$('.item').forEach((i) => i.addEventListener('click', () => { setView(i.dataset.view); closeDrawers(); }));

$('#sendBtn').addEventListener('click', () => (streaming ? streaming.abort() : send()));
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', (e) => {
  const touch = matchMedia('(pointer:coarse)').matches;
  if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); send(); }
});

$('#system').addEventListener('input', (e) => { settings.system = e.target.value; saveSettings(); });
$('#temp').addEventListener('input', (e) => { settings.temperature = Number(e.target.value); $('#tempO').textContent = settings.temperature.toFixed(2); saveSettings(); });
$('#topp').addEventListener('input', (e) => { settings.topP = Number(e.target.value); $('#toppO').textContent = settings.topP.toFixed(2); saveSettings(); });
$('#maxt').addEventListener('change', (e) => {
  const n = Math.round(Number(e.target.value));
  settings.maxTokens = Number.isFinite(n) ? Math.min(65536, Math.max(1, n)) : defaults.maxTokens;
  e.target.value = settings.maxTokens; saveSettings();
});

$('#copyKey').addEventListener('click', () => fullKey && copyText(fullKey));
$('#regen').addEventListener('click', async () => {
  if (!confirm('Regenerate your API key? The current key will stop working immediately.')) return;
  const btn = $('#regen'); btn.disabled = true;
  try {
    const r = await api('/api/keys/regenerate', { method: 'POST' });
    fullKey = r.key; me.keyPrefix = r.keyPrefix; renderKeyPage(); toast('New key created');
  } catch (error) { toast(error.message); }
  btn.disabled = false;
});

// Copy buttons on code blocks (works for streamed and static blocks).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const code = btn.closest('.code').querySelector('pre code');
  if (code) copyText(code.textContent);
});

// ---- boot ----------------------------------------------------------------------------------------
(async function boot() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (!cfg.configured) throw new Error('Firebase is not configured. Check the FIREBASE_* values in .env.');
    auth = getAuth(initializeApp(cfg.firebaseConfig));
    onAuthStateChanged(auth, (u) => { user = u; if (u) enter(); else leave(); });
  } catch (error) {
    showLoginError(error.message || 'Could not start TruX Studio.');
    $('#googleBtn').disabled = true;
  }
})();
