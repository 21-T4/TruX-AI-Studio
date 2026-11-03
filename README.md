# TruX Studio
Dark "model garden" + playground + API on Google Cloud (Vertex AI / Gemini Enterprise Agent Platform), with Firebase Google sign-in, per-user API keys and a usage dashboard.

## Setup
1. `cp .env.example .env` → fill `FIREBASE_API_KEY`, `FIREBASE_APP_ID` (project ID is auto-detected from GCP).
2. Firebase console: enable **Authentication → Google**, create **Firestore** (Native), add your domain to Authorized domains.
3. GCP: enable the **Vertex AI API**. Locally: `gcloud auth application-default login`. In production the service account needs **Vertex AI User** + **Cloud Datastore User**.
4. `npm install && npm start` → http://localhost:3000

## Docker / Cloud Run
```
docker build -t trux-studio .
gcloud run deploy trux-studio --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars FIREBASE_API_KEY=...,FIREBASE_APP_ID=...
```
(Give the Cloud Run service account the two roles above.) `docker-compose.yml` is included for local Docker with a service-account key.

## API
```
curl https://YOUR_HOST/v1/chat -H "Authorization: Bearer trux_xxx" -H "Content-Type: application/json" \
  -d '{"model":"trux-2.2","messages":[{"role":"user","content":"Hello"}],"thinking":"medium"}'
```
Optional fields: `system`, `temperature` (only models that support it), `thinking` (`low|medium|high`), `max_tokens`. `GET /v1/models` lists models.

## Model map (verified Nov 3, 2026) — edit `models.js` to change
| TruX | Google ID | Status |
|---|---|---|
| 1.5 core | gemini-3.5-flash-lite | OK, 35 free req/day/user |
| 2.0 | gemini-3.6-flash | **Google retires it Nov 19, 2026**; auto-falls back to gemini-3.7-flash on 404 |
| 2.1 | gemini-3.7-flash | OK (retires Jan 28, 2027) |
| 2.2 | gemini-3.8-flash | OK |
| 4.0 | gemini-3.1-pro-preview | OK (preview) |
| 5.0 | gemini-4-argon | GA since Oct 13, 2026, paid only |
| Research / Research Max | gemini-3.8-flash / gemini-4-argon + Google Search grounding | OK |
| TruX-Live | gemini-3.8-live (fallback gemini-live-2.5-flash-native-audio) | may need allowlisting on Vertex |
| TruX-Live Classic | gemini-live-2.5-flash-native-audio | retires Dec 13, 2026 |
