'use strict';

// Public TruX model names -> Vertex AI model ids. Users only ever see the TruX names.
// If Google publishes a model under a slightly different id, change `vertex` here
// (or override it with an env var such as VERTEX_MODEL_TRUX_2_0=...).
const BASE = [
  { id: 'trux-1.5-core', name: 'TruX 1.5 Core', vertex: 'gemini-3.5-flash-lite', dailyLimit: 35,
    tagline: 'Light and quick for everyday prompts' },
  { id: 'trux-2.0', name: 'TruX 2.0', vertex: 'gemini-3.6-flash', dailyLimit: 0,
    tagline: 'Balanced speed and quality' },
  { id: 'trux-2.1', name: 'TruX 2.1', vertex: 'gemini-3.7-flash', dailyLimit: 0,
    tagline: 'Sharper answers, still fast' },
  { id: 'trux-2.2', name: 'TruX 2.2', vertex: 'gemini-3.8-flash', dailyLimit: 0,
    tagline: 'The newest fast model' },
  { id: 'trux-4.0', name: 'TruX 4.0', vertex: 'gemini-3.1-pro-preview', dailyLimit: 0,
    tagline: 'Deep reasoning for hard problems' },
  { id: 'trux-5.0', name: 'TruX 5.0', vertex: 'gemini-4-argon', dailyLimit: 0,
    tagline: 'Flagship. Most capable' }
];

const envName = (id) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function limitFor(model) {
  const raw = process.env['DAILY_LIMIT_' + envName(model.id)];
  if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
    return Math.max(0, Math.floor(Number(raw)));
  }
  return model.dailyLimit;
}

const MODELS = BASE.map((m) => ({
  ...m,
  key: m.id.replace(/[^a-z0-9]/g, '_'),
  vertex: process.env['VERTEX_MODEL_' + envName(m.id)] || m.vertex,
  dailyLimit: limitFor(m)
}));

function getModel(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return MODELS.find((m) => m.id === needle || m.name.toLowerCase() === needle) || null;
}

// Never expose the underlying Vertex model id.
function publicModel(m) {
  return { id: m.id, name: m.name, tagline: m.tagline, dailyLimit: m.dailyLimit };
}

module.exports = { MODELS, getModel, publicModel };
