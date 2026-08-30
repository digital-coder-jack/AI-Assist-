const { readDiscordToken, readConfiguredChannelIds, logTokenDiagnostic, logChannelDiagnostic } = require('./config');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const MAX_DISCORD_LENGTH = 2000;
const DELETE_DELAY_MS = 15000;
const contextLimit = Math.max(2, Number(process.env.FORGE_ASSIST_CONTEXT_LIMIT || 12));
const conversations = new Map();
const archivedEventIds = new Set();
const processedMessageIds = new Set();
const deletionTimers = new Set();
const archiveStats = { totalQueries: 0, successfulQueries: 0, failedQueries: 0, attachments: 0, providers: {}, languages: {} };

function isDirectMessage(message) { return !message.guildId; }
function conversationKey(message) { return `dm:${message.author.id}`; }
function keyFor(message) { return isDirectMessage(message) ? conversationKey(message) : `${message.guildId}:${message.channelId}:${message.author.id}`; }
function configuredChannelIds(env = process.env) { return readConfiguredChannelIds(env); }
function targetReason(message, client, env = process.env) {
  if (message.author?.bot) return 'author_is_bot';
  if (isDirectMessage(message)) return 'direct_message';
  if (client?.user && message.mentions?.has(client.user)) return 'direct_mention';
  const channelId = String(message.channelId || message.channel?.id || '');
  if (configuredChannelIds(env).includes(channelId)) return 'configured_channel';
  return 'not_targeted';
}
function shouldRespond(message, client, env = process.env) { return ['direct_message', 'direct_mention', 'configured_channel'].includes(targetReason(message, client, env)); }
function logMessageDiagnostic(message, client, logger = console, env = process.env) { const reason = targetReason(message, client, env); const type = isDirectMessage(message) ? 'dm' : 'guild'; const targeted = reason !== 'not_targeted' && reason !== 'author_is_bot'; logger.log(`[forge-assist] message received: type=${type} guild=${message.guildId || 'dm'} channel=${message.channelId || 'unknown'} authorBot=${Boolean(message.author?.bot)} targeted=${targeted} reason=${reason}`); return reason; }
function cleanPrompt(message, client) { return String(message.content || '').replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim(); }
function getContext(key) { return conversations.get(key) || []; }
function saveTurn(key, user, assistant) { conversations.set(key, [...getContext(key), { role: 'user', content: user }, { role: 'assistant', content: assistant }].slice(-contextLimit)); }
function languageOf(text = '') { const lower = text.toLowerCase(); if (/[\u0900-\u097f]/.test(text)) return 'Hindi'; if (/\b(bhai|hai|kya|kaise|kyu|kar|ye|mujhe|samjha|bata)\b/.test(lower)) return 'Hinglish'; if (/\b(the|what|why|how|please|explain|error|code)\b/.test(lower)) return 'English'; return 'Other'; }
function splitMessage(text) { const chunks = []; let rest = String(text || '').trim(); while (rest.length > MAX_DISCORD_LENGTH) { let cut = rest.lastIndexOf('\n', MAX_DISCORD_LENGTH); if (cut < 500) cut = rest.lastIndexOf(' ', MAX_DISCORD_LENGTH); if (cut < 1) cut = MAX_DISCORD_LENGTH; chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); } if (rest) chunks.push(rest); return chunks.length ? chunks : ['Forge Assist is temporarily unavailable.']; }
function attachmentMetadata(message) { return [...(message.attachments?.values?.() || [])].map(x => ({ id: x.id, url: x.url, filename: x.name, contentType: x.contentType || 'application/octet-stream', size: x.size })); }
function attachmentFiles(message) { return attachmentMetadata(message).map(x => ({ attachment: x.url, name: x.filename })); }

async function askBackend(message, prompt, env = process.env, scope = keyFor(message), attachments = []) {
  const base = (env.FORGE_ASSIST_BACKEND_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('FORGE_ASSIST_BACKEND_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.FORGE_ASSIST_REQUEST_TIMEOUT_MS || 25000));
  try {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-forge-assist-secret': env.FORGE_ASSIST_API_SECRET || '' }, body: JSON.stringify({ message: prompt, context: getContext(scope), attachments: attachments.map(({ id, filename, contentType, size }) => ({ id, filename, contentType, size })) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.response !== 'string') throw new Error(data.message || `backend returned ${response.status}`);
    return { response: data.response, provider: data.provider || 'unknown' };
  } finally { clearTimeout(timer); }
}

async function postArchive(event) {
  const base = (process.env.FORGE_ASSIST_BACKEND_URL || '').replace(/\/$/, '');
  if (!base || !process.env.TELEGRAM_BOT_TOKEN || !process.env.FORGE_DATA_CENTER_2_CHAT_ID || archivedEventIds.has(event.eventId)) return;
  archivedEventIds.add(event.eventId);
  try { const response = await fetch(`${base}/api/assist/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-assist-secret': process.env.FORGE_ASSIST_API_SECRET || '' }, body: JSON.stringify(event) }); if (!response.ok) throw new Error(`archive returned ${response.status}`); } catch (error) { archivedEventIds.delete(event.eventId); console.error(`[forge-assist] Telegram archive failed: ${error.message}`); }
}
function archiveEvent(message, prompt, success, provider, response = '', scope = keyFor(message)) {
  const attachments = attachmentMetadata(message); const language = languageOf(prompt); archiveStats.totalQueries += 1; if (success) archiveStats.successfulQueries += 1; else archiveStats.failedQueries += 1; archiveStats.providers[provider] = archiveStats.providers[provider] || { success: 0, failure: 0 }; archiveStats.providers[provider][success ? 'success' : 'failure'] += 1; archiveStats.languages[language] = (archiveStats.languages[language] || 0) + 1; archiveStats.attachments += attachments.length;
  const eventId = `${message.id}:${success ? 'success' : 'failure'}`;
  void postArchive({ eventId, messageId: message.id, guildId: message.guildId || null, userId: message.author.id, username: message.author.username, question: prompt, response, success, provider, language, timestamp: message.createdAt?.toISOString() || new Date().toISOString(), conversationId: scope, totalQueries: archiveStats.totalQueries, successfulQueries: archiveStats.successfulQueries, failedQueries: archiveStats.failedQueries, activeConversations: conversations.size, contextMessageCount: getContext(scope).length, attachments });
}
function logGuildDiagnostics(client, logger = console, env = process.env) { const user = client.user; const guilds = [...client.guilds.cache.values()]; logger.log(`[forge-assist] logged in as ${user.tag}`); logger.log(`[forge-assist] bot user ID: ${user.id}`); if (env.DISCORD_APPLICATION_ID) logger.log(`[forge-assist] configured application ID matches logged-in bot: ${String(env.DISCORD_APPLICATION_ID).trim() === user.id}`); logger.log(`[forge-assist] guild count: ${guilds.length}`); if (!guilds.length) logger.log('[forge-assist] serving 0 guilds'); for (const guild of guilds) logger.log(`[forge-assist] guild: ${guild.name} (${guild.id})`); return guilds; }
async function sendPrivateRedirect(message) { await message.reply('For privacy, please continue this conversation with Forge Assist in a direct message (DM).'); }
async function openPrivateConversation(message, logger = console) { const dm = await message.author.send('Hey! I\'ve moved this conversation to DM so your AI chat stays private.'); const files = attachmentFiles(message); if (files.length) { try { await dm.channel.send({ files }); } catch (error) { logger.log(`[forge-assist] private attachment forwarding skipped: ${error.message}`); } } return dm.channel; }
function scheduleDeletion(message, logger = console, setTimer = setTimeout) { if (deletionTimers.has(message.id)) return; deletionTimers.add(message.id); setTimer(async () => { try { await message.delete(); } catch (error) { if (error?.code !== 10008 && error?.code !== 10003) logger.log(`[forge-assist] public message deletion skipped: ${error.message}`); } finally { deletionTimers.delete(message.id); } }, DELETE_DELAY_MS); }
async function sendResponse(channel, response) { let first = true; for (const part of splitMessage(response)) { if (first && typeof channel.send === 'function' && channel.lastReply) { await channel.send(part); } else await channel.send(part); first = false; } }

async function processPrivateQuery(message, channel, prompt, { logger = console, env = process.env, scope = keyFor(message), schedulePublicDeletion = false } = {}) {
  const attachments = attachmentMetadata(message);
  try {
    await channel.sendTyping?.();
    const backendPromise = askBackend(message, prompt, env, scope, attachments);
    if (schedulePublicDeletion) scheduleDeletion(message, logger);
    const result = await backendPromise;
    saveTurn(scope, prompt, result.response);
    archiveEvent(message, prompt, true, result.provider, result.response, scope);
    await sendResponse(channel, result.response);
    return { handled: true, reason: 'private_response', provider: result.provider };
  } catch (error) {
    logger.log(`[forge-assist] message handling failed: ${error.message}`);
    archiveEvent(message, prompt, false, 'unknown', '', scope);
    if (schedulePublicDeletion) scheduleDeletion(message, logger);
    await channel.send('I\'m temporarily unable to reach my AI backend. Please try again in a moment.').catch(replyError => logger.log(`[forge-assist] private reply failed: ${replyError.message}`));
    return { handled: true, reason: 'backend_error' };
  }
}
async function handleMessage(message, client, { logger = console, env = process.env } = {}) {
  logMessageDiagnostic(message, client, logger, env); const reason = targetReason(message, client, env); if (reason === 'author_is_bot') return { handled: false, reason }; if (reason === 'not_targeted') return { handled: false, reason }; if (processedMessageIds.has(message.id)) { logger.log('[forge-assist] duplicate message ignored'); return { handled: false, reason: 'duplicate' }; } processedMessageIds.add(message.id);
  if (reason === 'configured_channel') { await sendPrivateRedirect(message); return { handled: true, reason: 'public_redirect' }; }
  const prompt = cleanPrompt(message, client); if (!prompt && !message.attachments?.size) { await message.reply?.('Hey! Ask me something and I\'ll help.'); return { handled: true, reason: 'empty_prompt' }; }
  const scope = conversationKey(message);
  if (reason === 'direct_mention') { let dm; try { dm = await openPrivateConversation(message, logger); } catch (error) { logger.log(`[forge-assist] private DM could not be started: ${error.message}`); await message.reply?.('I could not start a private DM. Please check your Discord privacy settings and try again.').catch(() => {}); return { handled: true, reason: 'dm_failed' }; } return processPrivateQuery(message, dm, prompt || 'Please help with the attached file.', { logger, env, scope, schedulePublicDeletion: true }); }
  return processPrivateQuery(message, message.channel, prompt || 'Please help with the attached file.', { logger, env, scope });
}
function registerMessageHandlers(client, { logger = console, env = process.env } = {}) { client.on('messageCreate', message => handleMessage(message, client, { logger, env })); return client; }
function createBot() { const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] }); client.once('ready', () => logGuildDiagnostics(client)); return registerMessageHandlers(client); }
async function startBot({ env = process.env, botFactory = createBot, logger = console } = {}) { const token = readDiscordToken(env); logTokenDiagnostic(token, logger); logChannelDiagnostic(readConfiguredChannelIds(env), logger); if (!token) throw new Error('DISCORD_TOKEN is required'); return botFactory().login(token); }
if (require.main === module) startBot().catch(error => { console.error(`[forge-assist] startup failed: ${error.message}`); process.exitCode = 1; });
module.exports = { createBot, startBot, logGuildDiagnostics, logMessageDiagnostic, registerMessageHandlers, handleMessage, processPrivateQuery, scheduleDeletion, splitMessage, shouldRespond, targetReason, conversations, archiveEvent, postArchive, archiveStats, _test: { processedMessageIds, deletionTimers, sendPrivateRedirect, openPrivateConversation, keyFor, conversationKey, isDirectMessage, attachmentMetadata }, _internals: { askBackend, cleanPrompt, languageOf, getContext, saveTurn }, _resetForTests: () => { conversations.clear(); processedMessageIds.clear(); archivedEventIds.clear(); deletionTimers.clear(); archiveStats.totalQueries = 0; archiveStats.successfulQueries = 0; archiveStats.failedQueries = 0; archiveStats.attachments = 0; archiveStats.providers = {}; archiveStats.languages = {}; } };
