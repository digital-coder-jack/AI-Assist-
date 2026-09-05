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
    -> Telegram Data Center Bot API
    -> private FORGE_DATA_CENTER_2_CHAT_ID destination

Discord `/contact your message`
    -> Vercel: POST /api/assist/contact
    -> Telegram Contact Bot
    -> configured owner chat

Owner Telegram Reply button/message
    -> Vercel: POST /api/assist/telegram-contact
    -> Discord REST API
    -> original Discord channel/user context
```

The bot processes `/contact your message` and `/owner your message` as deterministic owner-contact commands before normal AI handling. Normal messages in channels listed in `FORGE_ASSIST_CHANNEL_IDS` are handled publicly, replying in the same channel. A direct mention in a public channel is moved to a private DM: the original question is processed once, the AI response is sent only by DM, and the triggering public message is best-effort deleted after approximately 15 seconds. Direct messages are handled privately without requiring a mention. Messages outside configured channels are ignored unless they directly mention the bot. Bot-authored messages are ignored. DM conversation context is isolated strictly by Discord user ID and capped by `FORGE_ASSIST_CONTEXT_LIMIT`. Responses preserve the latest user language and conversational style. Provider failures are isolated and use the existing Claude/Kimi/Groq fallback sequence.

## Deployment

### Vercel

Deploy the repository root as a Vercel project. Serverless entry points are `api/health.js`, `api/chat.js`, `api/assist/events.js`, `api/assist/contact.js`, and `api/assist/telegram-contact.js`. Vercel does not host the Discord Gateway or any permanent process. Configure the AI variables, `FORGE_ASSIST_API_SECRET`, `TELEGRAM_BOT_TOKEN`, `FORGE_DATA_CENTER_2_CHAT_ID`, `TELEGRAM_CONTACT_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, and `DISCORD_TOKEN`. Optionally configure `TELEGRAM_CONTACT_WEBHOOK_SECRET`; otherwise the existing `FORGE_ASSIST_API_SECRET` is used for Telegram webhook verification. `DISCORD_TOKEN` is needed in Vercel only for owner replies delivered through Discord's REST API.

### Wispbyte

Run `npm install` and start with `npm start`. Configure `DISCORD_TOKEN`, `FORGE_ASSIST_BACKEND_URL`, and `FORGE_ASSIST_API_SECRET`. The existing Data Center Telegram variables may remain configured here for deployment consistency, but Telegram API calls are owned by Vercel. Enable Discord Message Content Intent. Users contact the owner with `/contact your message` in a handled DM or configured channel; `/owner your message` is accepted as an alias.

## Data Center 2 archive

Each processed question, including public-channel questions and private DM questions, is sent to the private Telegram destination with the username, Discord user ID, guild ID when available, question, AI response, timestamp, language, provider, event ID, and attachment names. A compact statistics message accompanies each archive event with query totals tracked by the running Wispbyte process, provider outcomes, language counts, active conversations, and context count. Private questions and responses are never written to Wispbyte logs.

Attachments sent in a private DM are associated with that Discord user and forwarded through the existing Telegram Data Center 2 archive path using Discord CDN URLs. This supports practical images, videos, PDFs, documents, text files, spreadsheets, archives, and audio where Telegram accepts the file and size. Attachment URLs are not printed in Wispbyte logs and are not exposed in Discord. If Telegram rejects an attachment, the system logs only a safe failure summary; the Discord user still receives the AI answer when the backend succeeds.

The archive event ID is derived from the Discord message ID and outcome, and an in-process set prevents duplicate submissions during the lifetime of the Wispbyte process. Telegram Bot API has no durable idempotency store in this implementation, so a process restart or an ambiguous network timeout can still require manual duplicate cleanup. No database, object-storage service, admin dashboard, Telegram admin allowlist, or `TELEGRAM_ADMIN_IDS` variable is used.

## API contract

`POST /api/chat` accepts `{ "message": "...", "context": [...] }` and returns `{ "response": "...", "provider": "..." }`. `POST /api/assist/events` accepts the archive event and its attachment URL metadata. `POST /api/assist/contact` accepts a contact event from Wispbyte and returns a stable `requestId` only after the Contact Bot API accepts the owner message. `POST /api/assist/telegram-contact` accepts Telegram webhook updates authenticated by `x-telegram-bot-api-secret-token`; callback routes are signed with `FORGE_ASSIST_API_SECRET`, and owner authorization always compares the numeric `TELEGRAM_OWNER_CHAT_ID`. Both existing archive/API routes use the `x-forge-assist-secret` header when `FORGE_ASSIST_API_SECRET` is configured. `GET /api/health` is public and returns a small status object without secrets.

After deployment, configure the Contact Bot webhook to `https://<your-vercel-domain>/api/assist/telegram-contact` using Telegram's `setWebhook` method and the value of `TELEGRAM_CONTACT_WEBHOOK_SECRET` (or `FORGE_ASSIST_API_SECRET` when the optional variable is omitted).

## Environment variables

Required or optional variables are documented in `.env.example`. Keep all values empty in that file and provide real values only in Vercel/Wispbyte environment configuration. The private Telegram chat or channel must be configured so the Telegram bot can post to it.

## Owner contact lifecycle and limitations

A contact request is keyed by a stable session-derived `FA-REQ-XXXXXXXX` ID. Multiple messages in the same active Discord conversation reuse that request ID; the Vercel process forwards them to the owner and records a compact `CONTACT_REQUEST` card in Data Center 2. The owner receives Reply and Close controls. Reply mode embeds a signed route containing the request ID, Discord user/channel/message mapping, and creation time, so routing never depends on usernames or message text. Closed and expired routes are rejected, and duplicate Telegram update IDs and Discord contact event IDs are suppressed in-process.

No database or object store was added. Telegram remains the durable human-readable record destination, while signed routing data allows owner replies to cross normal Vercel invocation boundaries. Because the existing architecture has no read/query interface for Telegram history, the implementation cannot reconstruct arbitrary closed-request state after every possible serverless cold start; active reply prompts remain protected by signed, expiring routes, and close state is enforced for the lifetime of the webhook process. Internet search, community knowledge, and member-information approval are not implemented. Real Discord and Telegram calls require deployment credentials and were not executed in this sandbox; unit tests and syntax checks are run locally.
