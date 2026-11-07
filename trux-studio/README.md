# TruX Studio

A dark AI studio (like Google AI Studio / Claude Playground) for the TruX model family.

- Google sign-in with Firebase (same Firebase project as TruX-Code, config in `.env`)
- Every user automatically gets a personal API key (shown in full once, only a SHA-256 hash is stored)
- All model calls go through Vertex AI
- OpenAI-compatible API you can call from the terminal

## Models

| Public name    | API id          | Limit                |
|----------------|-----------------|----------------------|
| TruX 1.5 Core  | `trux-1.5-core` | 35 requests/day free |
| TruX 2.0       | `trux-2.0`      | unlimited            |
| TruX 2.1       | `trux-2.1`      | unlimited            |
| TruX 2.2       | `trux-2.2`      | unlimited            |
| TruX 4.0       | `trux-4.0`      | unlimited            |
| TruX 5.0       | `trux-5.0`      | unlimited            |

The Vertex AI model ids behind each name live in `lib/models.js`. If an id differs in your project, edit it there
or set an env var like `VERTEX_MODEL_TRUX_5_0=...`. Limits can be changed in `.env`, for example
`DAILY_LIMIT_TRUX_5_0=100` (0 means unlimited). Counters reset at 00:00 UTC.

## One-time Google Cloud / Firebase setup (project `trux-ai`)

1. Firebase console > Authentication > Sign-in method: enable **Google**.
2. Authentication > Settings > **Authorized domains**: add your Studio domain (and `localhost` for local testing).
3. Enable **Firestore** (Native mode) and deploy `firestore.rules` (blocks all browser access; the server uses the Admin SDK).
4. Enable the **Vertex AI API**.
5. Give the Cloud Run service account these roles: `Vertex AI User` (`roles/aiplatform.user`) and
   `Cloud Datastore User` (`roles/datastore.user`).

## Deploy to Cloud Run

```bash
gcloud run deploy trux-studio --source . --region us-central1 --allow-unauthenticated --project trux-ai
```

## Run locally

```bash
gcloud auth application-default login
npm install
npm start        # http://localhost:8080
```

## Call it from the terminal

Sign in, open **API key**, copy your key, then:

```bash
curl -N https://YOUR-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer trux-XXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"trux-2.0","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'
```

Works with the OpenAI SDKs too: set `base_url` to `https://YOUR-DOMAIN/v1` and `api_key` to your TruX key.

## Notes

- Only Firebase **web** config is in `.env`; it is public client config, not a secret.
- Chat history is saved in the browser (localStorage). Keys, users and usage counters live in Firestore.
