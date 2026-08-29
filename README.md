# Forge Assist

Forge Assist is a separate Discord AI assistant designed for natural conversations. The Discord Gateway process runs on Wispbyte, while a stateless HTTP backend runs on Vercel and owns provider credentials. Existing bots and unrelated repository features are not present in this initial repository and are left untouched.

## Architecture

```text
Discord member
    -> Wispbyte: src/bot/index.js
    -> HTTPS POST /api/chat
    -> Vercel: api/chat.js
    -> Provider Manager: src/backend/providers.js
       -> Claude, Kimi, or Groq in configured priority order
    -> response to Wispbyte
    -> Discord reply
```

The bot answers only when directly mentioned, when a message replies to the bot, or when its channel ID is listed in `FORGE_ASSIST_CHANNEL_IDS`. It does not read every server message by default. Context is isolated by guild/channel/member and capped by `FORGE_ASSIST_CONTEXT_LIMIT`; it is intentionally in-memory on the Wispbyte process, so a restart clears it. The backend accepts context in each request, leaving room for a persistent database adapter later without changing provider code.

Responses preserve the prompt's language through the provider system instruction, including Hindi, English, and Hinglish. Responses longer than Discord's 2,000-character limit are split at sensible newline or word boundaries. Provider calls are sequential and fail over from `AI_PROVIDER_ORDER`; a timeout, rate limit, invalid key, network error, unavailable service, or malformed response is logged without secrets and does not terminate the bot.

## Deployment

### Vercel backend

Deploy the repository as a Vercel project using the repository root. The exact serverless entry points are `api/health.js` and `api/chat.js`; no Discord Gateway or long-running process is required on Vercel. Set the backend variables from `.env.example`: `CLAUDE_API_KEY`, `KIMI_API_KEY`, `GROQ_API_KEY`, `FORGE_ASSIST_API_SECRET`, and any provider/model or timeout overrides. At least one provider key is required. Test the deployment with `GET https://<deployment-domain>/api/health`, which returns `{ "status": "ok", "service": "forge-assist-backend" }`.

### Wispbyte Discord bot

Run `npm install` once and start with `npm start` (or `node src/bot/index.js`). Set `DISCORD_TOKEN`, `FORGE_ASSIST_BACKEND_URL` to the Vercel deployment origin, and the same `FORGE_ASSIST_API_SECRET` used by Vercel. `FORGE_ASSIST_REQUEST_TIMEOUT_MS`, `FORGE_ASSIST_CONTEXT_LIMIT`, and `FORGE_ASSIST_CHANNEL_IDS` are optional. Enable Discord's Message Content Intent for the bot application. The Wispbyte process makes HTTPS requests only; it never receives provider API keys.

### API contract

`POST /api/chat` requires the `x-forge-assist-secret` header when `FORGE_ASSIST_API_SECRET` is configured. Its JSON body is `{ "message": "...", "context": [{"role":"user|assistant","content":"..."}] }`. A successful response is `{ "response": "...", "provider": "claude|kimi|groq" }`. Temporary provider failure returns HTTP 503 with a friendly error message. `GET /api/health` is intentionally unauthenticated and exposes no secrets.

## Internet search status

No search provider is implemented in Phase 1, and the assistant does not fabricate current-information results. The backend/provider boundary is isolated so a real search interface can be added later. Forge Tech Reporter integration is explicitly out of scope and has not been added.

## Security and scope

API keys, tokens, and the shared backend secret are environment-only. The shared secret is sent in an HTTP header, never in a query parameter, and is never logged. The system prompt permits defensive security and educational content while redirecting harmful requests. The implementation does not modify or integrate Forge Guardian, Forge Tech Reporter, moderation, onboarding, or profile systems.

## Limitations

Real Discord and AI provider calls require deployment credentials and were not executed in this sandbox. Provider defaults can be overridden because model availability changes over time. Context is process memory and is lost after a bot restart; production persistence can be introduced behind the existing request context without exposing provider credentials to Discord.

## Forge Data Center 2

Forge Data Center 2 is logically separate from any community/profile data and is dedicated to Forge Assist analytics. The Vercel API stores user summaries, question history, provider outcomes, language counts, and attachment metadata in the JSON object `FORGE_ASSIST_S3_DATA_KEY` inside an S3-compatible bucket. Actual attachment bytes are stored as separate objects under `forge-assist/attachments/`; the system never relies on temporary Discord URLs as permanent references and never stores binary files inside the JSON record.

The Wispbyte bot sends telemetry and attachment metadata asynchronously after processing a question. Data Center 2 outages therefore do not block or crash Discord replies. Attachment ingestion downloads the Discord file immediately and refuses files above `FORGE_ASSIST_MAX_ATTACHMENT_BYTES` rather than falsely claiming persistence.

### Data Center 2 API

The authenticated ingestion routes are `POST /api/assist/events` and `POST /api/assist/attachment`. Administrative reads are available through `GET /api/assist/admin?action=stats`, `user&userId=<id>`, `questions&page=1&size=10`, and `attachments`. Administrative API reads require both the shared `x-forge-assist-secret` and `x-forge-assist-admin-key` headers.

### Telegram administration

`POST /api/telegram/webhook` is a Vercel-compatible Telegram webhook handler. It uses the existing-bot strategy when an existing bot is present; this repository had no existing Telegram bot, so the handler is a dedicated Forge Assist administration interface. Only IDs listed in `TELEGRAM_ADMIN_IDS` are authorized. Unauthorized Telegram users receive no data. Supported commands are `/assist`, `/assist_user <Discord User ID>`, `/assist_questions [search]`, `/assist_search <text>`, and `/assist_attachments`. Question results are capped to a short page to avoid oversized Telegram messages; attachment commands provide stored references rather than automatically sending potentially large files. Configure the Telegram webhook externally to point to the deployed `/api/telegram/webhook` URL.

Telegram availability does not affect the Discord bot. Telegram and API errors are logged without tokens or private payloads and receive a safe temporary-error response where appropriate.
