const { requestId, cleanMessage, sendOwnerMessage } = require('../../src/backend/telegram-contact');
const { archiveEvent } = require('../../src/backend/telegram-archive');

const requests = new Map();
const recentMessages = new Map();
const processedEvents = new Set();
const MAX_MESSAGES_PER_WINDOW = 8;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function authorized(req) { return !process.env.FORGE_ASSIST_API_SECRET || req.headers['x-forge-assist-secret'] === process.env.FORGE_ASSIST_API_SECRET; }
function now() { return new Date().toISOString(); }
function validEvent(event) { return event && typeof event.eventId === 'string' && event.eventId && event.userId && event.discordChannelId && event.sessionId && event.message; }
function rateAllowed(userId, timestamp = Date.now()) {
  const values = (recentMessages.get(String(userId)) || []).filter(value => timestamp - value < RATE_WINDOW_MS);
  if (values.length >= MAX_MESSAGES_PER_WINDOW) { recentMessages.set(String(userId), values); return false; }
  values.push(timestamp); recentMessages.set(String(userId), values); return true;
}
function getRequest(event) {
  const id = requestId(event.sessionId);
  const previous = requests.get(id);
  if (previous && (previous.status === 'OPEN' || previous.status === 'WAITING_FOR_OWNER' || previous.status === 'WAITING_FOR_USER')) return { ...previous, lastActivityAt: now(), status: 'WAITING_FOR_OWNER' };
  return { requestId: id, discordUserId: String(event.userId), username: event.username || null, displayName: event.displayName || null, guildId: event.guildId || null, guildName: event.guildName || null, discordChannelId: String(event.discordChannelId), discordMessageId: event.discordMessageId || event.messageId || null, channelId: String(event.discordChannelId), channelName: event.channelName || null, ownerChatId: String(process.env.TELEGRAM_OWNER_CHAT_ID || ''), createdAt: previous?.createdAt || now(), lastActivityAt: now(), status: 'WAITING_FOR_OWNER', sessionId: String(event.sessionId) };
}
async function safeArchive(event, env) {
  try { return await archiveEvent(event, env); } catch (error) { console.error(`[forge-assist] contact archive failed: ${error.message}`); return { archived: false }; }
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const event = req.body || {};
  if (!validEvent(event)) return res.status(400).json({ error: 'eventId_userId_discordChannelId_sessionId_and_message_required' });
  if (processedEvents.has(event.eventId)) return res.status(202).json({ delivered: true, duplicate: true, requestId: requestId(event.sessionId) });
  let message;
  try { message = cleanMessage(event.message); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!rateAllowed(event.userId)) return res.status(429).json({ error: 'contact_rate_limited' });
  const request = getRequest({ ...event, message });
  try {
    await sendOwnerMessage(request, message, process.env);
    processedEvents.add(event.eventId);
    requests.set(request.requestId, request);
    await safeArchive({ type: 'CONTACT_REQUEST', eventId: event.eventId, requestId: request.requestId, sessionId: request.sessionId, userId: request.discordUserId, username: request.username, displayName: request.displayName, guildId: request.guildId, guildName: request.guildName, channelId: request.channelId, channelName: request.channelName, discordMessageId: request.discordMessageId, ownerChatId: request.ownerChatId, message, status: request.status, createdAt: request.createdAt, lastActivityAt: request.lastActivityAt }, process.env);
    return res.status(202).json({ delivered: true, requestId: request.requestId });
  } catch (error) {
    console.error(`[forge-assist] contact delivery failed: ${error.message}`);
    return res.status(503).json({ error: 'contact_delivery_unavailable' });
  }
};
module.exports._test = { requests, recentMessages, processedEvents, rateAllowed, getRequest, reset: () => { requests.clear(); recentMessages.clear(); processedEvents.clear(); } };
