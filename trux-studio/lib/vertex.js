'use strict';

const { GoogleAuth } = require('google-auth-library');

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

function endpoint(model) {
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const location = process.env.VERTEX_AI_LOCATION || 'global';
  const host = location === 'global' ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' + project + '/locations/' + location +
    '/publishers/google/models/' + model + ':streamGenerateContent?alt=sse';
}

// Streams a Vertex AI generation. Yields { text } chunks, then one { usage } event.
async function* stream({ model, system, messages, temperature, topP, maxTokens, signal }) {
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  const body = {
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig: { temperature, topP, maxOutputTokens: maxTokens }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(endpoint(model), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 600);
    const err = new Error('Upstream model error');
    err.upstream = true;
    err.upstreamStatus = res.status;
    err.detail = detail;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;

  const handle = function* (line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    const parts = (json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts) || [];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text && !part.thought) yield { text: part.text };
    }
    if (json.usageMetadata) {
      usage = {
        prompt: json.usageMetadata.promptTokenCount || 0,
        completion: json.usageMetadata.candidatesTokenCount || 0,
        total: json.usageMetadata.totalTokenCount || 0
      };
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      yield* handle(line);
    }
  }
  if (buffer.trim()) yield* handle(buffer.trim());
  yield { usage: usage || { prompt: 0, completion: 0, total: 0 } };
}

module.exports = { stream };
