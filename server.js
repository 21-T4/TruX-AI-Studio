require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");
const WebSocket = require("ws");
const { GoogleAuth } = require("google-auth-library");
const MODELS = require("./models");

const gauth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
let PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const LOC = process.env.VERTEX_LOCATION || "global";
const LIVE_LOC = process.env.VERTEX_LIVE_LOCATION || "us-central1";
const host = (l) => (l === "global" ? "aiplatform.googleapis.com" : `${l}-aiplatform.googleapis.com`);
const sk = (id) => id.replace(/\./g, "_");
const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newKey = () => "trux_" + crypto.randomBytes(24).toString("hex");
async function bearer() { const t = await (await gauth.getClient()).getAccessToken(); return t.token || t; }
const publicModel = (id, m) => ({ id, name: m.name, type: m.type, desc: m.desc, ctx: m.ctx, max_output: m.maxOut,
  inputs: m.inputs, outputs: m.outputs, daily_limit: m.dailyLimit || null, temperature: !!m.temperature, sample: m.sample });

(async () => {
  if (!PROJECT) PROJECT = await gauth.getProjectId();
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT });
  const db = admin.firestore();
  const inc = admin.firestore.FieldValue.increment;

  async function ensureUser(uid, email) {
    const ref = db.collection("users").doc(uid);
    const s = await ref.get();
    if (s.exists) return s.data();
    const key = newKey();
    const data = { email: email || null, apiKey: key, createdAt: Date.now() };
    await ref.set(data);
    await db.collection("apikeys").doc(sha(key)).set({ uid });
    return data;
  }

  async function auth(req, res, next) {
    try {
      const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
      if (!tok) return res.status(401).json({ error: "Missing credentials" });
      if (tok.startsWith("trux_")) {
        const k = await db.collection("apikeys").doc(sha(tok)).get();
        if (!k.exists) return res.status(401).json({ error: "Invalid API key" });
        req.uid = k.data().uid;
      } else {
        const d = await admin.auth().verifyIdToken(tok);
        req.uid = d.uid; req.email = d.email;
      }
      req.user = await ensureUser(req.uid, req.email);
      next();
    } catch (e) { res.status(401).json({ error: "Unauthorized" }); }
  }

  const usageDoc = (uid) => db.collection("usage").doc(`${uid}_${today()}`);
  const record = (uid, model, u) => usageDoc(uid).set({ uid, day: today(),
    m: { [sk(model)]: { req: inc(1), in: inc(u?.promptTokenCount || 0), out: inc(u?.candidatesTokenCount || 0) } } }, { merge: true });

  async function generate(m, body) {
    let last;
    for (const id of [m.vertexId, m.fallback].filter(Boolean)) {
      const url = `https://${host(LOC)}/v1/projects/${PROJECT}/locations/${LOC}/publishers/google/models/${id}:generateContent`;
      const r = await fetch(url, { method: "POST", body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" } });
      const j = await r.json();
      if (r.ok) return j;
      last = { status: r.status, error: j.error?.message || "Upstream error" };
      if (r.status !== 404) break; // fall back only if model is gone/not found
    }
    throw last;
  }

  async function liveTurn(m, text, system) {
    let last;
    for (const id of [m.vertexId, m.fallback].filter(Boolean)) {
      try {
        const tok = await bearer();
        return await new Promise((resolve, reject) => {
          const ws = new WebSocket(`wss://${host(LIVE_LOC)}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`,
            { headers: { Authorization: `Bearer ${tok}` } });
          let out = "", done = false, timer;
          const fin = (e) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch (_) {} e ? reject(e) : resolve(out); };
          timer = setTimeout(() => fin(new Error("Live session timed out")), 60000);
          ws.on("open", () => ws.send(JSON.stringify({ setup: {
            model: `projects/${PROJECT}/locations/${LIVE_LOC}/publishers/google/models/${id}`,
            generationConfig: { responseModalities: ["AUDIO"] }, outputAudioTranscription: {},
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) } })));
          ws.on("message", (d) => {
            const j = JSON.parse(d.toString());
            if (j.setupComplete) ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
            const sc = j.serverContent;
            if (sc?.outputTranscription?.text) out += sc.outputTranscription.text;
            if (sc?.turnComplete) fin();
          });
          ws.on("error", (e) => fin(e));
          ws.on("close", () => fin(out ? null : new Error("Live connection closed")));
        });
      } catch (e) { last = e; }
    }
    throw { status: 502, error: `Live API error: ${last?.message || last}` };
  }

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.static("public"));
  app.get("/healthz", (q, r) => r.send("ok"));

  app.get("/api/config", (req, res) => res.json({ apiKey: process.env.FIREBASE_API_KEY, appId: process.env.FIREBASE_APP_ID,
    projectId: PROJECT, authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${PROJECT}.firebaseapp.com` }));
  app.get("/api/models", (q, r) => r.json(Object.entries(MODELS).map(([id, m]) => publicModel(id, m))));
  app.get("/v1/models", (q, r) => r.json({ data: Object.entries(MODELS).map(([id, m]) => publicModel(id, m)) }));

  app.get("/api/me", auth, (req, res) => res.json({ email: req.user.email, apiKey: req.user.apiKey }));

  app.get("/api/usage", auth, async (req, res) => {
    const days = Math.min(+req.query.days || 14, 90);
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const snap = await db.collection("usage").where("uid", "==", req.uid).get();
    res.json({ days: snap.docs.map((d) => d.data()).filter((d) => d.day >= cutoff).sort((a, b) => a.day.localeCompare(b.day)) });
  });

  app.post("/api/key/regenerate", auth, async (req, res) => {
    await db.collection("apikeys").doc(sha(req.user.apiKey)).delete();
    const key = newKey();
    await db.collection("users").doc(req.uid).update({ apiKey: key });
    await db.collection("apikeys").doc(sha(key)).set({ uid: req.uid });
    res.json({ apiKey: key });
  });

  // POST /v1/chat { model, messages:[{role,content}], system?, temperature?, thinking?: low|medium|high, max_tokens? }
  app.post("/v1/chat", auth, async (req, res) => {
    try {
      const { model = "trux-1.5-core", messages, system, temperature, thinking, max_tokens } = req.body || {};
      const m = MODELS[model];
      if (!m) return res.status(400).json({ error: `Unknown model. Use one of: ${Object.keys(MODELS).join(", ")}` });
      if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "messages[] required" });

      if (m.dailyLimit) {
        const s = await usageDoc(req.uid).get();
        if ((s.data()?.m?.[sk(model)]?.req || 0) >= m.dailyLimit)
          return res.status(429).json({ error: `Daily free limit of ${m.dailyLimit} requests reached for ${m.name}` });
      }

      if (m.type === "live") {
        const last = [...messages].reverse().find((x) => x.role === "user");
        const output = await liveTurn(m, String(last?.content || ""), system);
        await record(req.uid, model, null);
        return res.json({ model, name: m.name, output });
      }

      const gc = { maxOutputTokens: max_tokens ?? 8192 };
      if (m.temperature && temperature != null) gc.temperature = temperature;
      const th = thinking || m.thinking;
      if (th) gc.thinkingConfig = { thinkingLevel: String(th).toUpperCase() };
      const body = { contents: messages.map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: String(x.content) }] })), generationConfig: gc };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (m.grounding) body.tools = [{ googleSearch: {} }];

      const j = await generate(m, body);
      await record(req.uid, model, j.usageMetadata);
      const c = j.candidates?.[0];
      const output = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      const sources = (c?.groundingMetadata?.groundingChunks || []).map((g) => g.web && { title: g.web.title, url: g.web.uri }).filter(Boolean);
      res.json({ model, name: m.name, output, ...(m.grounding ? { sources } : {}), usage: j.usageMetadata || null });
    } catch (e) {
      console.error(e);
      res.status(e.status || 500).json({ error: e.error || "Server error" });
    }
  });

  app.listen(process.env.PORT || 3000, () => console.log(`TruX Studio on :${process.env.PORT || 3000} (project ${PROJECT})`));
})();
