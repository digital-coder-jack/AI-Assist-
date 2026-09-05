const TELEGRAM_LIMIT = 4096;
const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const IST_TIME_ZONE = 'Asia/Kolkata';

function config(env = process.env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.FORGE_DATA_CENTER_2_CHAT_ID) throw new Error('Telegram Data Center 2 is not configured');
  return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.FORGE_DATA_CENTER_2_CHAT_ID };
}

async function telegram(method, payload, env = process.env) {
  const { token } = config(env);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(`Telegram ${method} failed (${response.status})`);
  return data.result;
}

function chunk(text) {
  const out = [];
  let rest = String(text);
  while (rest.length > TELEGRAM_LIMIT) {
    let cut = rest.lastIndexOf('\n', TELEGRAM_LIMIT);
    if (cut < 1) cut = rest.lastIndexOf(' ', TELEGRAM_LIMIT);
    if (cut < 1) cut = TELEGRAM_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function archiveRecord(type, fields) {
  return ['[FORGE_ASSIST]', `schema_version=${LEGACY_SCHEMA_VERSION}`, `record_type=${type}`, ...Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value ?? null)}`)].join('\n');
}

function parseArchiveRecord(text) {
  const lines = String(text).split('\n');
  if (lines[0] !== '[FORGE_ASSIST]') throw new Error('invalid Forge Assist archive record');
  return Object.fromEntries(lines.slice(1).filter(Boolean).map(line => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('invalid Forge Assist archive field');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
  }));
}

function normalizeContent(value) {
  return String(value ?? '')
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\t/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function display(value, fallback = 'Not available') {
  const text = normalizeContent(value);
  return text || fallback;
}

function istTimestamp(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return display(value);
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(date).replace(',', '');
}

function statusLabel(success) { return success ? '✅ Successful' : '❌ Failed'; }
function userLabel(event) { return event.username ? `@${event.username}` : display(event.displayName || event.userId); }
function communityLabel(event) { return event.guildName || event.guildId || 'Direct message'; }
function contextLabel(event) { return event.channelName || event.channelId || (event.mode === 'private_dm' ? 'DM' : 'Not available'); }
function internalMetadata(event, extra = {}) {
  const fields = { record_id: extra.recordId || event.eventId || event.sessionId || event.discordUserId || event.userId, event_id: event.eventId, session_id: event.sessionId, message_id: event.messageId, source: extra.source || 'discord', ...extra };
  return Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => `${key}: ${normalizeContent(value)}`).join(' • ');
}
function card(title, sections, internal) {
  const lines = ['🧠 FORGE ASSIST', '━━━━━━━━━━━━━━━━', title, ...sections.filter(Boolean), '', `🕐 ${istTimestamp(internal.timestamp)}`, '━━━━━━━━━━━━━━━━'];
  if (internal.metadata) lines.push(`🔧 Internal Metadata: ${internal.metadata}`);
  return lines.join('\n');
}

function memberRecordText(event) {
  return card('👤 Community Member Record', [
    `👤 User: ${userLabel(event)}`,
    `🆔 Discord ID: ${display(event.userId)}`,
    `🏠 Community: ${communityLabel(event)}`,
    `💬 Context: ${display(event.mode, 'Not available')}`,
    `🌐 Language: ${display(event.language, 'Other')}`,
    `📌 Status: ${event.memberEventType === 'MEMBER_CREATED' ? 'Created' : 'Updated'}`,
  ], { timestamp: event.timestamp, metadata: internalMetadata(event, { record_type: event.memberEventType || 'MEMBER_UPDATED' }) });
}

function sessionRecordText(event) {
  return card('📌 Session Record', [
    `👤 User: ${userLabel(event)}`,
    `🆔 Discord ID: ${display(event.userId)}`,
    `🏠 Community: ${communityLabel(event)}`,
    `📍 Context: ${contextLabel(event)}`,
    `📊 Queries: ${event.totalQueries ?? 0} total • ${event.successfulQueries ?? 0} successful • ${event.failedQueries ?? 0} failed`,
    `🤖 Provider: ${display(event.provider, 'Unknown')}`,
    `📈 Session status: ${event.success === false ? 'Active with failures' : 'Active'}`,
  ], { timestamp: event.timestamp || event.sessionCreatedAt, metadata: internalMetadata(event, { record_type: 'SESSION_RECORD', session_event: event.sessionEventType || 'SESSION_STARTED' }) });
}

function queryRecordText(event) {
  return card('💬 Query Record', [
    `👤 User: ${userLabel(event)}`,
    `🆔 Discord ID: ${display(event.userId)}`,
    `🏠 Community: ${communityLabel(event)}`,
    `📍 Context: ${contextLabel(event)}`,
    '', '❓ Question', display(normalizeContent(event.question)), '', '🤖 Response', display(normalizeContent(event.response), 'No response available.'), '', `🌐 Language: ${display(event.language, 'Other')}`, `🤖 Provider: ${display(event.provider, 'Unknown')}`, `⏱ Status: ${statusLabel(Boolean(event.success))}`,
  ], { timestamp: event.timestamp, metadata: internalMetadata(event, { record_type: 'QUERY_RECORD', query_id: event.eventId }) });
}

function conversationRecordText(event) {
  return card('📌 Conversation Record', [
    `👤 User: ${userLabel(event)}`,
    `🆔 Discord ID: ${display(event.userId)}`,
    `🏠 Community: ${communityLabel(event)}`,
    `💬 Context: ${contextLabel(event)}`,
    `🌐 Language: ${display(event.language, 'Other')}`,
    `🤖 Provider: ${display(event.provider, 'Unknown')}`,
    '', `📊 Queries`, `• Total: ${event.totalQueries ?? 1}`, `• Successful: ${event.successfulQueries ?? (event.success ? 1 : 0)}`, `• Failed: ${event.failedQueries ?? (event.success ? 0 : 1)}`, `💭 Active conversations: ${event.activeConversations ?? 0}`, `🧠 Context messages: ${event.contextMessageCount ?? 0}`, '', `Status: ${statusLabel(Boolean(event.success))}`,
  ], { timestamp: event.timestamp, metadata: internalMetadata(event, { record_type: 'CONVERSATION_RECORD', conversation_id: event.conversationId || event.sessionId }) });
}

function statsText(event) {
  return card('⚙️ System Event Record', [
    `👤 User: ${userLabel(event)}`,
    `🆔 Discord ID: ${display(event.userId)}`,
    `🏠 Community: ${communityLabel(event)}`,
    `📊 Event: ${event.success === false ? 'Query failed' : 'Query completed'}`,
    `🤖 Provider: ${display(event.provider, 'Unknown')}`,
    `🌐 Language: ${display(event.language, 'Other')}`,
    `📈 Archive totals: ${event.totalQueries ?? 0} total • ${event.successfulQueries ?? 0} successful • ${event.failedQueries ?? 0} failed`,
  ], { timestamp: event.timestamp, metadata: internalMetadata(event, { record_type: 'SYSTEM_EVENT_RECORD', event_type: 'QUERY_STATUS' }) });
}

function contactRequestRecordText(event) {
  return card('📩 Contact Request', [
    `👤 User: ${event.username ? `@${event.username}` : display(event.displayName || event.userId)}`,
    `🆔 Discord ID: ${display(event.userId)}`,
    `🏠 Community: ${display(event.guildName || event.guildId, 'Direct message')}`,
    `📍 Channel: ${display(event.channelName || event.channelId)}`,
    '', '💬 Initial Message:', display(normalizeContent(event.message)),
    '', `🆔 Request ID: ${display(event.requestId)}`, `📊 Status: ${display(event.status, 'WAITING_FOR_OWNER')}`,
  ], { timestamp: event.createdAt || event.lastActivityAt, metadata: internalMetadata(event, { record_type: 'CONTACT_REQUEST', request_id: event.requestId, session_id: event.sessionId, owner_chat_id: event.ownerChatId }) });
}

function onboardingRecordText(event) {
  const profile = event.profile || event.onboarding || {};
  return card('👤 Community Profile Record', [
    `👤 User: ${display(event.username || event.displayName || event.globalName)}`,
    `🆔 Discord ID: ${display(event.discordUserId)}`,
    `🏠 Community: ${display(event.guildName || event.guildId)}`,
    `🏷 Roles: ${Array.isArray(event.roles) && event.roles.length ? event.roles.join(', ') : 'None provided'}`,
    `💼 Work / professional information: ${display(profile.work || profile.professional || profile.profession, 'Not provided')}`,
    `🧠 Experience: ${display(profile.experience, 'Not provided')}`,
    `🎯 Interests: ${display(profile.interests, 'Not provided')}`,
    `📍 Source: ${display(event.metadata?.source, 'Discord community data')}`,
  ], { timestamp: event.timestamp || event.metadata?.capturedAt || event.updatedAt, metadata: internalMetadata({ ...event, userId: event.discordUserId, eventId: event.eventId }, { record_type: 'COMMUNITY_PROFILE_RECORD', source: event.metadata?.source || 'discord' }) });
}

async function sendRecord(text, chatId, env) {
  for (const part of chunk(text)) await telegram('sendMessage', { chat_id: chatId, text: part }, env);
}

async function archiveEvent(event, env = process.env) {
  const { chatId } = config(env);
  if (event.type === 'CONTACT_REQUEST') {
    await sendRecord(contactRequestRecordText(event), chatId, env);
    return { archived: true, eventId: event.eventId || event.requestId };
  }
  if (event.type === 'MEMBER_ONBOARDING') {
    await sendRecord(onboardingRecordText(event), chatId, env);
    return { archived: true, eventId: event.eventId };
  }
  if (event.memberEventType) await sendRecord(memberRecordText(event), chatId, env);
  if (event.sessionEventType) await sendRecord(sessionRecordText(event), chatId, env);
  await sendRecord(queryRecordText(event), chatId, env);
  await sendRecord(conversationRecordText(event), chatId, env);
  for (const attachment of event.attachments || []) {
    try {
      await telegram('sendDocument', { chat_id: chatId, document: attachment.url, caption: `Forge Assist attachment\n${display(attachment.filename)}\nType: ${display(attachment.contentType, 'unknown')}\nSize: ${attachment.size || 'unknown'} bytes` }, env);
    } catch (error) {
      console.error(`[forge-assist] Telegram attachment unavailable: ${error.message}`);
      await telegram('sendMessage', { chat_id: chatId, text: 'Attachment archive failed. See the related query record for its stable ID.' }, env).catch(() => {});
    }
  }
  await sendRecord(statsText(event), chatId, env);
  return { archived: true, eventId: event.eventId };
}

module.exports = { archiveEvent, config, chunk, archiveRecord, parseArchiveRecord, normalizeContent, istTimestamp, memberRecordText, sessionRecordText, queryRecordText, conversationRecordText, statsText, contactRequestRecordText, onboardingRecordText, SCHEMA_VERSION };
