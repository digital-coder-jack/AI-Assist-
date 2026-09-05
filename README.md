# Forge Assist

Forge Assist is a separate Discord AI assistant. The Discord Gateway and message handling run on Wispbyte, while the stateless AI/API backend runs on Vercel. Forge Data Center 2 is a private Telegram destination owned by the operator; it receives archive messages through a Telegram bot.

## Architecture

```text
Discord member
    -> Wispbyte: src/bot/index.js
    -> Vercel: POST /api/chat
    -> explicit Discord community context
    -> optional Tavily web search retrieval for current/public questions
    -> Claude / Kimi / Groq with failover
    -> relevant user-scoped member memory + short-term context
    -> grounded Discord reply

Configured public-channel message without mention
    -> Vercel: POST /api/chat
    -> public-channel reply

Configured public-channel mention
    -> private DM handoff
    -> Vercel: POST /api/chat
    -> private DM reply
    -> triggering message deletion after ~15 seconds

Wispbyte archive event
    -> Vercel: POST /api/assist/events
    -> Telegram Bot API
    -> private FORGE_DATA_CENTER_2_CHAT_ID destination
```

The bot processes normal messages in channels listed in `FORGE_ASSIST_CHANNEL_IDS` publicly, replying in the same channel. A direct mention in a public channel is moved to a private DM: the original question is processed once, the AI response is sent only by DM, and the triggering public message is best-effort deleted after approximately 15 seconds. Direct messages are handled privately without requiring a mention. Messages outside configured channels are ignored unless they directly mention the bot. Bot-authored messages are ignored. DM conversation context is isolated strictly by Discord user ID and capped by `FORGE_ASSIST_CONTEXT_LIMIT`. Responses preserve the latest user language and conversational style. Provider failures are isolated and use the existing Claude/Kimi/Groq fallback sequence. A small long-term memory layer stores only explicit, useful, non-sensitive member statements, retrieves only relevant items for the same Discord user ID, and keeps memory invisible in normal replies.

## Deployment

### Vercel

Deploy the repository root as a Vercel project. Serverless entry points are `api/health.js`, `api/chat.js`, and `api/assist/events.js`. Vercel does not host the Discord Gateway or any permanent process. Configure the AI variables, `FORGE_ASSIST_API_SECRET`, `TELEGRAM_BOT_TOKEN`, and `FORGE_DATA_CENTER_2_CHAT_ID`. For optional current/public web search, configure `WEB_SEARCH_ENABLED=true`, `TAVILY_API_KEY`, and optionally `WEB_SEARCH_TIMEOUT_MS` in Vercel only. Keep `TAVILY_API_KEY` in Vercel only.

### Wispbyte

Run `npm install` and start with `npm start`. Configure `DISCORD_TOKEN`, `FORGE_ASSIST_BACKEND_URL`, and `FORGE_ASSIST_API_SECRET`. Do not place `TAVILY_API_KEY` in Wispbyte. Enable Discord Message Content Intent.

## Data Center 2 archive

Each processed question, including public-channel questions and private DM questions, is sent to the private Telegram destination with the username, Discord user ID, guild ID when available, question, AI response, timestamp, language, provider, event ID, and attachment names. A compact statistics message accompanies each archive event with query totals tracked by the running Wispbyte process, provider outcomes, language counts, active conversations, and context count. Private questions and responses are never written to Wispbyte logs.

Explicit long-term member memories are archived through the same Telegram Data Center 2 event path as `MEMORY_RECORD` cards. These records contain a stable memory ID, the Discord user ID, the explicit member statement, broad topic labels, and a safety note. They never contain credentials or inferred sensitive attributes. The Telegram archive is write-only in the current implementation; the active Wispbyte process maintains the retrieval index, while Telegram remains the existing persistence/archive destination rather than a new database.

Attachments sent in a private DM are associated with that Discord user and forwarded through the existing Telegram Data Center 2 archive path using Discord CDN URLs. This supports practical images, videos, PDFs, documents, text files, spreadsheets, archives, and audio where Telegram accepts the file and size. Attachment URLs are not printed in Wispbyte logs and are not exposed in Discord. If Telegram rejects an attachment, the system logs only a safe failure summary; the Discord user still receives the AI answer when the backend succeeds.

The archive event ID is derived from the Discord message ID and outcome, and an in-process set prevents duplicate submissions during the lifetime of the Wispbyte process. Telegram Bot API has no durable idempotency store in this implementation, so a process restart or an ambiguous network timeout can still require manual duplicate cleanup. No database, object-storage service, admin dashboard, Telegram admin allowlist, or `TELEGRAM_ADMIN_IDS` variable is used.

## API contract

`POST /api/chat` accepts `{ "message": "...", "context": [...], "memory": { "status": "...", "items": [...] }, "community": {...} }` and returns `{ "response": "...", "provider": "...", "route": "...", "language": "...", "sources": [...] }`. The backend accepts only bounded memory text supplied by the already user-scoped Discord process and does not identify members by username. `POST /api/assist/events` accepts the archive event and its attachment URL metadata. The chat route uses the `x-forge-assist-secret` header when `FORGE_ASSIST_API_SECRET` is configured. `GET /api/health` is public and returns a small status object without secrets.

Community context is limited to explicit guild/channel metadata and public role names; role names are never treated as personal attributes. Web search is selective and server-side: stable general questions do not search, while current/latest/news/explicit online-search questions may use Tavily. Search snippets are bounded and passed to the existing provider as grounded context with source URLs. Forge Assist introduces itself only when asked, identifies itself as the Developer Forge assistant, attributes its configuration/build to Jack as the Developer Forge community admin, and does not present Claude, Kimi, Groq, ChatGPT, or OpenAI as its public identity.

## Environment variables

Required or optional variables are documented in `.env.example`. Keep all values empty in that file and provide real values only in Vercel/Wispbyte environment configuration. The private Telegram chat or channel must be configured so the Telegram bot can post to it.

## Scope and limitations

Forge Tech Reporter, Forge Guardian, and unrelated existing features are not modified. Telegram remains persistence-only; no Telegram DM/reply or owner-approval workflow is implemented. Long-term memory is intentionally conservative: explicit forget requests clear matching in-process memory and emit a memory archive record; the current write-only Telegram archive does not provide message-history retrieval after a cold restart, so deployment should treat the running Wispbyte memory index and Telegram archive as complementary. Tavily web search is optional and disabled by default. If its key is missing, the provider fails, times out, or returns no results, Forge Assist does not crash or invent current facts; it falls back to the existing AI flow with no web evidence. Real Discord, Telegram, web-search, and AI-provider calls require deployment credentials and were not executed in this sandbox; unit tests and syntax checks are run locally.
