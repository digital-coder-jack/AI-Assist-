const crypto = require('node:crypto');

const TELEGRAM_LIMIT = 4096;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONTACT_MESSAGE_LENGTH = 4000;
const CONTACT_PREFIX = 'FA-REQ-';
const processedOwnerMessageIds = new Set();
const processedCallbackIds = new Set();
const forwardedContactEventIds = new Set();
const closedRequestIds = new Set();

function config(env = process.env) {
  if (!env.TELEGRAM_CONTACT_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID || !env.FORGE_ASSIST_API_SECRET) throw new Error('Telegram contact bot is not configured');
  return { token: env.TELEGRAM_CONTACT_BOT_TOKEN, ownerChatId: String(env.TELEGRAM_OWNER_CHAT_ID), signingSecret: env.FORGE_ASSIST_API_SECRET };
}

function normalizeId(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) throw new Error('invalid Telegram owner chat ID');
  return text;
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function fromBase64url(value) { return Buffer.from(value, 'base64url').toString('utf8'); }
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url').slice(0, 24); }
function encodeRoute(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}
function decodeRoute(token, secret) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw new Error('invalid contact route');
  const expected = sign(body, secret);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('invalid contact route');
  const payload = JSON.parse(fromBase64url(body));
  if (!payload.requestId || !payload.discordUserId || !payload.discordChannelId) throw new Error('incomplete contact route');
  return payload;
}

function requestId(sessionId) {
  const digest = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8).toUpperCase();
  return `${CONTACT_PREFIX}${digest}`;
}
function split(text) {
  const out = [];
  let rest = String(text || '');
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
function cleanMessage(value) {
  const message = String(value ?? '').replace(/\\r\\n|\\n|\\r/g, '\n').replace(/<br\s*\/?>/gi, '\n').trim();
  if (!message) throw new Error('contact message is required');
  if (message.length > MAX_CONTACT_MESSAGE_LENGTH) throw new Error('contact message is too long');
  return message;
}
function display(value, fallback = 'Not available') { const text = String(value ?? '').trim(); return text || fallback; }
function istTimestamp(value) { return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value || Date.now())).replace(',', ''); }
function ownerCard(request, route, message) {
  return ['━━━━━━━━━━━━━━━━━━', '📩 FORGE ASSIST', 'OWNER CONTACT', '━━━━━━━━━━━━━━━━━━', '', '👤 User', display(request.username ? `@${request.username}` : request.displayName), '', '🆔 Discord ID', display(request.discordUserId), '', '🏠 Community', display(request.guildName || request.guildId, 'Direct message'), '', '📍 Channel', display(request.channelName || request.channelId), '', '💬 Message', `"${cleanMessage(message)}"`, '', '🆔 Request', request.requestId, '', '🕐 ' + istTimestamp(request.lastActivityAt), '', '━━━━━━━━━━━━━━━━━━', '', `Status: ${request.status === 'WAITING_FOR_OWNER' ? '🟡 Waiting for owner' : '🔵 Open'}`].join('\n');
}
function ownerReplyCard(request, message) { return ['📤 FORGE ASSIST', 'OWNER REPLY', '', `Request: ${request.requestId}`, '', cleanMessage(message), '', `🕐 ${istTimestamp(Date.now())}`].join('\n'); }
function keyboard(route) { return { inline_keyboard: [[{ text: '↩️ Reply', callback_data: `reply:${route}` }, { text: '✅ Close', callback_data: `close:${route}` }]] }; }

async function telegram(method, payload, env = process.env) {
  const { token } = config(env);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(`Telegram contact ${method} failed (${response.status})`);
  return data.result;
}
async function sendOwnerMessage(request, message, env = process.env) {
  const { ownerChatId, signingSecret } = config(env);
  const route = encodeRoute({ requestId: request.requestId, discordUserId: request.discordUserId, discordChannelId: request.discordChannelId, discordGuildId: request.guildId || null, discordMessageId: request.discordMessageId || null, requestSessionId: request.sessionId, createdAt: request.createdAt }, signingSecret);
  const parts = split(ownerCard(request, route, message));
  let first;
  for (const part of parts) first = await telegram('sendMessage', { chat_id: ownerChatId, text: part, reply_markup: keyboard(route) }, env);
  return first;
}
function isOwnerChat(chatId, env = process.env) { return String(chatId ?? '') === normalizeId(config(env).ownerChatId); }
function resetForTests() { processedOwnerMessageIds.clear(); processedCallbackIds.clear(); forwardedContactEventIds.clear(); closedRequestIds.clear(); }

async function answerCallback(update, env = process.env) {
  const callback = update.callback_query;
  if (!callback || !isOwnerChat(callback.message?.chat?.id, env)) return { handled: false, reason: 'unauthorized' };
  if (processedCallbackIds.has(callback.id)) return { handled: false, reason: 'duplicate_callback' };
  processedCallbackIds.add(callback.id);
  const [action, route] = String(callback.data || '').split(/:(.+)/s);
  if (!route || !['reply', 'close'].includes(action)) return { handled: false, reason: 'invalid_callback' };
  let payload;
  try { payload = decodeRoute(route, config(env).signingSecret); } catch { return { handled: false, reason: 'invalid_route' }; }
  await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: action === 'close' ? 'Contact request closed.' : 'Reply to this message with your response.' }, env);
  if (action === 'close') {
    closedRequestIds.add(payload.requestId);
    await telegram('editMessageReplyMarkup', { chat_id: config(env).ownerChatId, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }, env).catch(() => {});
    await telegram('sendMessage', { chat_id: config(env).ownerChatId, text: `✅ ${payload.requestId} is closed. New Discord messages may reopen the same request.` }, env);
    return { handled: true, action, requestId: payload.requestId };
  }
  await telegram('sendMessage', { chat_id: config(env).ownerChatId, text: `↩️ Reply mode for ${payload.requestId}. Reply directly to this prompt.\nRouting token: ${route}`, reply_parameters: { message_id: callback.message.message_id }, force_reply: true }, env);
  return { handled: true, action, requestId: payload.requestId, payload };
}

async function ownerReply(update, env = process.env, deliverDiscord) {
  const message = update.message;
  if (!message || !isOwnerChat(message.chat?.id, env) || !message.text || !message.reply_to_message) return { handled: false, reason: 'not_owner_reply' };
  if (processedOwnerMessageIds.has(message.message_id)) return { handled: false, reason: 'duplicate_owner_message' };
  const source = message.reply_to_message.text || '';
  const match = source.match(/(FA-REQ-[A-Z0-9]+)/);
  if (!match) return { handled: false, reason: 'request_not_found' };
  const requestIdValue = match[1];
  processedOwnerMessageIds.add(message.message_id);
  let payload;
  try {
    const tokenMatch = source.match(/(?:reply|close):([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|Routing token:\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    if (tokenMatch) payload = decodeRoute(tokenMatch[1] || tokenMatch[2], config(env).signingSecret);
  } catch { return { handled: false, reason: 'invalid_route' }; }
  if (!payload || payload.requestId !== requestIdValue) return { handled: false, reason: 'request_not_found' };
  if (closedRequestIds.has(payload.requestId)) { await telegram('sendMessage', { chat_id: config(env).ownerChatId, text: '⚠️ This contact request is no longer active.' }, env); return { handled: false, reason: 'closed_request' }; }
  if (payload.createdAt && Date.now() - new Date(payload.createdAt).getTime() > REQUEST_TTL_MS) { await telegram('sendMessage', { chat_id: config(env).ownerChatId, text: '⚠️ This contact request has expired.' }, env); return { handled: false, reason: 'expired_request' }; }
  try {
    await deliverDiscord(payload, cleanMessage(message.text), { messageId: message.message_id });
    await telegram('sendMessage', { chat_id: config(env).ownerChatId, text: `✅ Reply delivered to ${requestIdValue}.` }, env);
    return { handled: true, requestId: requestIdValue };
  } catch (error) {
    processedOwnerMessageIds.delete(message.message_id);
    await telegram('sendMessage', { chat_id: config(env).ownerChatId, text: `⚠️ Reply delivery failed for ${requestIdValue}. The reply was not confirmed; retry it after the service recovers.` }, env).catch(() => {});
    return { handled: false, reason: 'discord_delivery_failed' };
  }
}

async function handleWebhook(update, env = process.env, deliverDiscord = async () => {}) {
  if (update?.callback_query) return answerCallback(update, env);
  if (update?.message) return ownerReply(update, env, deliverDiscord);
  return { handled: false, reason: 'unsupported_update' };
}

module.exports = { TELEGRAM_LIMIT, REQUEST_TTL_MS, MAX_CONTACT_MESSAGE_LENGTH, CONTACT_PREFIX, config, normalizeId, requestId, encodeRoute, decodeRoute, split, cleanMessage, ownerCard, ownerReplyCard, keyboard, telegram, sendOwnerMessage, isOwnerChat, answerCallback, ownerReply, handleWebhook, _test: { processedOwnerMessageIds, processedCallbackIds, forwardedContactEventIds, closedRequestIds }, resetForTests };
