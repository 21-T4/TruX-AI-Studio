'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { MODELS, getModel, publicModel } = require('./lib/models');
const store = require('./lib/store');
const vertex = require('./lib/vertex');

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT });

const app = express();
const publicDir = path.join(__dirname, 'public');
const RATE_PER_MIN = 40;

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '2mb' }));

// ---- helpers -------------------------------------------------------------------------------
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

const isV1 = (req) => req.originalUrl.startsWith('/v1/');

function sendError(req, res, error) {
  let status = error.status || 500;
  let message = error.expose ? error.message : 'Something went wrong. Try again.';

  if (error.upstream) {
    console.error('Vertex AI error', error.upstreamStatus, error.detail);
    if (error.upstreamStatus === 429) { status = 429; message = 'The model is busy right now. Try again shortly.'; }
    else if (error.upstreamStatus === 400) { status = 400; message = 'The model could not process this request.'; }
    else { status = 502; message = 'The model is unavailable right now. Try again shortly.'; }
  } else if (!error.expose) {
    console.error('Unhandled error:', error && (error.code || error.message));
  }

  if (res.headersSent) {
    if (!res.writableEnded) {
      if (isV1(req)) res.write('data: ' + JSON.stringify({ error: { message, type: 'trux_error' } }) + '\n\n');
      else res.write('data: ' + JSON.stringify({ error: message }) + '\n\n');
      res.end();
    }
    return;
  }
  res.status(status).json(isV1(req) ? { error: { message, type: 'trux_error' } } : { error: message });
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(req, res, e));

async function authenticate(req, { sessionOnly = false } = {}) {
  const header = req.get('authorization') || '';
  let token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : '';
  if (!token) token = (req.get('x-api-key') || '').trim();
  if (!token) throw httpError(401, 'Missing credentials. Send your TruX API key as "Authorization: Bearer <key>".');

  if (token.startsWith('trux-')) {
    if (sessionOnly) throw httpError(401, 'Sign in to TruX Studio to do this.');
    const uid = await store.uidForKey(token);
    if (!uid) throw httpError(401, 'Invalid API key.');
    return { uid, via: 'key' };
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return { uid: decoded.uid, via: 'session', decoded };
  } catch {
    throw httpError(401, 'Your sign-in expired. Sign in again.');
  }
}

const hits = new Map();
function rateLimit(uid) {
  const now = Date.now();
  const recent = (hits.get(uid) || []).filter((t) => now - t < 60000);
  if (recent.length >= RATE_PER_MIN) throw httpError(429, 'Too many requests. Slow down a little.');
  recent.push(now);
  hits.set(uid, recent);
}
setInterval(() => {
  const now = Date.now();
  for (const [uid, list] of hits) if (!list.some((t) => now - t < 60000)) hits.delete(uid);
}, 60000).unref();

function parseGeneration(body) {
  const model = getModel(body.model);
  if (!model) throw httpError(400, 'Unknown model. Available: ' + MODELS.map((m) => m.id).join(', '));
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw httpError(400, '"messages" must be a non-empty array.');
  }

  let system = typeof body.system === 'string' ? body.system.trim() : '';
  let total = system.length;
  const messages = [];
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') throw httpError(400, 'Each message must be an object.');
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
    }
    if (typeof content !== 'string') throw httpError(400, 'Each message needs a text "content".');
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') {
      throw httpError(400, 'Message role must be "system", "user" or "assistant".');
    }
    if (!content.trim()) continue;
    total += content.length;
    if (m.role === 'system') system = system ? system + '\n\n' + content : content;
    else messages.push({ role: m.role, content });
  }
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw httpError(400, 'The last message must be a non-empty user message.');
  }
  if (total > 400000) throw httpError(413, 'This conversation is too long.');

  const num = (value, min, max, fallback) => {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, n));
  };
  return {
    model, system, messages,
    temperature: num(body.temperature, 0, 2, 1),
    topP: num(body.top_p != null ? body.top_p : body.topP, 0, 1, 0.95),
    maxTokens: Math.round(num(body.max_tokens != null ? body.max_tokens : body.maxTokens, 1, 65536, 8192))
  };
}

// Takes one request from the user's daily quota, calls Vertex AI and waits for the first event, so quota
// and upstream failures are reported as normal JSON errors before any streaming headers are sent.
async function startGeneration(uid, p, signal) {
  const quota = await store.consume(uid, p.model);
  const iterator = vertex.stream({
    model: p.model.vertex, system: p.system, messages: p.messages,
    temperature: p.temperature, topP: p.topP, maxTokens: p.maxTokens, signal
  })[Symbol.asyncIterator]();
  let first;
  try {
    first = await iterator.next();
  } catch (error) {
    await store.refund(uid, p.model).catch(() => {});
    throw error;
  }
  return { quota, iterator, first };
}

async function* events(g) {
  let result = g.first;
  while (!result.done) {
    yield result.value;
    result = await g.iterator.next();
  }
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function abortOnClose(res) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  return controller;
}

// ---- routes: public ------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// Firebase web config is public client config, not a server credential.
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const get = (name) => String(process.env[name] || '').trim();
  const firebaseConfig = {
    apiKey: get('FIREBASE_API_KEY'),
    authDomain: get('FIREBASE_AUTH_DOMAIN'),
    projectId: get('FIREBASE_PROJECT_ID'),
    storageBucket: get('FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: get('FIREBASE_MESSAGING_SENDER_ID'),
    appId: get('FIREBASE_APP_ID'),
    measurementId: get('FIREBASE_MEASUREMENT_ID')
  };
  const configured = ['apiKey', 'authDomain', 'projectId', 'appId'].every((k) => firebaseConfig[k]);
  res.status(configured ? 200 : 503).json({ configured, firebaseConfig: configured ? firebaseConfig : null });
});

app.get('/api/models', (_req, res) => res.json({ models: MODELS.map(publicModel) }));

// ---- routes: studio account ----------------------------------------------------------------
app.get('/api/me', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = await authenticate(req, { sessionOnly: true });
  const profile = { email: a.decoded.email || '', displayName: a.decoded.name || '' };
  const issued = await store.ensureKey(a.uid, profile);
  res.json({
    user: { uid: a.uid, email: profile.email, displayName: profile.displayName, photoURL: a.decoded.picture || '' },
    key: issued.key,
    keyPrefix: issued.prefix,
    usage: await store.usageToday(a.uid),
    day: store.today()
  });
}));

app.post('/api/keys/regenerate', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = await authenticate(req, { sessionOnly: true });
  const issued = await store.rotateKey(a.uid, { email: a.decoded.email || '', displayName: a.decoded.name || '' });
  res.json({ key: issued.key, keyPrefix: issued.prefix });
}));

// Used by the Studio UI (Firebase sign-in) and also accepts a TruX API key.
app.post('/api/generate', wrap(async (req, res) => {
  const a = await authenticate(req);
  rateLimit(a.uid);
  const p = parseGeneration(req.body || {});
  const controller = abortOnClose(res);
  const g = await startGeneration(a.uid, p, controller.signal);

  openSse(res);
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  let usage = null;
  for await (const ev of events(g)) {
    if (ev.text) send({ text: ev.text });
    else if (ev.usage) usage = ev.usage;
  }
  send({ done: true, usage, quota: g.quota });
  res.end();
}));

// ---- routes: public API (OpenAI-compatible) --------------------------------------------------
app.get('/v1/models', wrap(async (req, res) => {
  await authenticate(req);
  res.json({ object: 'list', data: MODELS.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'trux' })) });
}));

app.post('/v1/chat/completions', wrap(async (req, res) => {
  const a = await authenticate(req);
  rateLimit(a.uid);
  const body = req.body || {};
  const p = parseGeneration(body);
  const controller = abortOnClose(res);
  const g = await startGeneration(a.uid, p, controller.signal);
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  if (body.stream) {
    openSse(res);
    const chunk = (delta, finish) => 'data: ' + JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: p.model.id,
      choices: [{ index: 0, delta, finish_reason: finish }]
    }) + '\n\n';
    res.write(chunk({ role: 'assistant', content: '' }, null));
    let usage = null;
    for await (const ev of events(g)) {
      if (ev.text) res.write(chunk({ content: ev.text }, null));
      else if (ev.usage) usage = ev.usage;
    }
    res.write(chunk({}, 'stop'));
    if (body.stream_options && body.stream_options.include_usage && usage) {
      res.write('data: ' + JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: p.model.id, choices: [],
        usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total }
      }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  let text = '';
  let usage = { prompt: 0, completion: 0, total: 0 };
  for await (const ev of events(g)) {
    if (ev.text) text += ev.text;
    else if (ev.usage) usage = ev.usage;
  }
  return res.json({
    id, object: 'chat.completion', created, model: p.model.id,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total }
  });
}));

// ---- static app ----------------------------------------------------------------------------
app.use(express.static(publicDir, { index: false, dotfiles: 'ignore' }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
    return res.status(404).json({ error: 'Route not found.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(publicDir, 'index.html'));
});

// Bad JSON bodies etc.
app.use((error, req, res, _next) => {
  if (error && error.type === 'entity.parse.failed') return sendError(req, res, httpError(400, 'Request body is not valid JSON.'));
  if (error && error.type === 'entity.too.large') return sendError(req, res, httpError(413, 'Request body is too large.'));
  return sendError(req, res, error);
});

const port = Number(process.env.PORT || 8080);
if (require.main === module) {
  app.listen(port, '0.0.0.0', () => console.log('TruX Studio listening on port ' + port));
}

module.exports = app;
