# Forge Assist

Forge Assist is a separate Discord AI assistant. The Discord Gateway and message handling run on Wispbyte, while the stateless AI/API backend runs on Vercel. Forge Data Center 2 is a private Telegram destination owned by the operator; it receives archive messages through a Telegram bot.

## Architecture

```text
Discord member
    -> Wispbyte: src/bot/index.js
    -> private Discord DM
    -> Vercel: POST /api/chat
    -> Claude / Kimi / Groq with failover
    -> private Discord DM reply

Configured public-channel message
    -> privacy redirect to DM
    -> no public AI request or response

Wispbyte archive event
    -> Vercel: POST /api/assist/events
    -> Telegram Bot API
    -> private FORGE_DATA_CENTER_2_CHAT_ID destination
```

The bot processes messages in two private-safe cases: direct messages to Forge Assist, and direct mentions in a guild. A normal message in a channel listed in `FORGE_ASSIST_CHANNEL_IDS` receives only a short public instruction to continue by DM; its question is not sent to AI and no AI response is posted publicly. Messages outside configured channels are ignored unless they directly mention the bot. Bot-authored messages are ignored. DM conversation context is isolated strictly by Discord user ID and capped by `FORGE_ASSIST_CONTEXT_LIMIT`. Responses preserve Hindi, English, and Hinglish naturally. Provider failures are isolated and use the existing Claude/Kimi/Groq fallback sequence.

## Deployment

### Vercel

Deploy the repository root as a Vercel project. Serverless entry points are `api/health.js`, `api/chat.js`, and `api/assist/events.js`. Vercel does not host the Discord Gateway or any permanent process. Configure the AI variables, `FORGE_ASSIST_API_SECRET`, `TELEGRAM_BOT_TOKEN`, and `FORGE_DATA_CENTER_2_CHAT_ID`.

### Wispbyte

Run `npm install` and start with `npm start`. Configure `DISCORD_TOKEN`, `FORGE_ASSIST_BACKEND_URL`, `FORGE_ASSIST_API_SECRET`, `TELEGRAM_BOT_TOKEN`, and `FORGE_DATA_CENTER_2_CHAT_ID`. The Telegram variables are used only to determine whether archiving is enabled; the bot sends archive data through the Vercel backend, which owns the Telegram API call. Enable Discord Message Content Intent.

## Data Center 2 archive

Each processed private question is sent to the private Telegram destination with the username, Discord user ID, guild ID when available, question, AI response, timestamp, language, provider, event ID, and attachment names. A compact statistics message accompanies each archive event with query totals tracked by the running Wispbyte process, provider outcomes, language counts, active conversations, and context count. Private questions and responses are never written to Wispbyte logs.

Attachments sent in a private DM are associated with that Discord user and forwarded through the existing Telegram Data Center 2 archive path using Discord CDN URLs. This supports practical images, videos, PDFs, documents, text files, spreadsheets, archives, and audio where Telegram accepts the file and size. Attachment URLs are not printed in Wispbyte logs and are not exposed in Discord. If Telegram rejects an attachment, the system logs only a safe failure summary; the Discord user still receives the AI answer when the backend succeeds.

The archive event ID is derived from the Discord message ID and outcome, and an in-process set prevents duplicate submissions during the lifetime of the Wispbyte process. Telegram Bot API has no durable idempotency store in this implementation, so a process restart or an ambiguous network timeout can still require manual duplicate cleanup. No database, object-storage service, admin dashboard, Telegram admin allowlist, or `TELEGRAM_ADMIN_IDS` variable is used.

## API contract

`POST /api/chat` accepts `{ "message": "...", "context": [...] }` and returns `{ "response": "...", "provider": "..." }`. `POST /api/assist/events` accepts the archive event and its attachment URL metadata. Both routes use the `x-forge-assist-secret` header when `FORGE_ASSIST_API_SECRET` is configured. `GET /api/health` is public and returns a small status object without secrets.

## Environment variables

Required or optional variables are documented in `.env.example`. Keep all values empty in that file and provide real values only in Vercel/Wispbyte environment configuration. The private Telegram chat or channel must be configured so the Telegram bot can post to it.

## Scope and limitations

Forge Tech Reporter, Forge Guardian, and unrelated existing features are not modified. Internet search is not implemented. Real Discord, Telegram, and AI-provider calls require deployment credentials and were not executed in this sandbox; unit tests and syntax checks are run locally.
