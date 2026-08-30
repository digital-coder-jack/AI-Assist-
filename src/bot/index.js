const { readDiscordToken, readConfiguredChannelIds, logTokenDiagnostic, logChannelDiagnostic } = require('./config');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const MAX_DISCORD_LENGTH = 2000;
const contextLimit = Math.max(2, Number(process.env.FORGE_ASSIST_CONTEXT_LIMIT || 12));
const conversations = new Map();
const archivedEventIds = new Set();
const processedMessageIds = new Set();
const archiveStats = { totalQueries: 0, successfulQueries: 0, failedQueries: 0, attachments: 0, providers: {}, languages: {} };

function isDirectMessage(message) { return !message.guildId; }
function keyFor(message) { return isDirectMessage(message) ? `dm:${message.author.id}` : `${message.guildId}:${message.channelId}:${message.author.id}`; }
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

async function askBackend(message, prompt, env = process.env) {
  const base = (env.FORGE_ASSIST_BACKEND_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('FORGE_ASSIST_BACKEND_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.FORGE_ASSIST_REQUEST_TIMEOUT_MS || 25000));
  try {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-forge-assist-secret': env.FORGE_ASSIST_API_SECRET || '' }, body: JSON.stringify({ message: prompt, context: getContext(keyFor(message)) }) });
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
function archiveEvent(message, prompt, success, provider, response = '') {
  const attachments = [...(message.attachments?.values?.() || [])].map(x => ({ id: x.id, url: x.url, filename: x.name, contentType: x.contentType || 'application/octet-stream', size: x.size }));
  const language = languageOf(prompt); archiveStats.totalQueries += 1; if (success) archiveStats.successfulQueries += 1; else archiveStats.failedQueries += 1; archiveStats.providers[provider] = archiveStats.providers[provider] || { success: 0, failure: 0 }; archiveStats.providers[provider][success ? 'success' : 'failure'] += 1; archiveStats.languages[language] = (archiveStats.languages[language] || 0) + 1; archiveStats.attachments += attachments.length;
  const eventId = `${message.id}:${success ? 'success' : 'failure'}`;
  void postArchive({ eventId, messageId: message.id, guildId: message.guildId || null, userId: message.author.id, username: message.author.username, question: prompt, response, success, provider, language, timestamp: message.createdAt?.toISOString() || new Date().toISOString(), totalQueries: archiveStats.totalQueries, successfulQueries: archiveStats.successfulQueries, failedQueries: archiveStats.failedQueries, activeConversations: conversations.size, contextMessageCount: getContext(keyFor(message)).length, attachments });
}
function logGuildDiagnostics(client, logger = console, env = process.env) { const user = client.user; const guilds = [...client.guilds.cache.values()]; logger.log(`[forge-assist] logged in as ${user.tag}`); logger.log(`[forge-assist] bot user ID: ${user.id}`); if (env.DISCORD_APPLICATION_ID) logger.log(`[forge-assist] configured application ID matches logged-in bot: ${String(env.DISCORD_APPLICATION_ID).trim() === user.id}`); logger.log(`[forge-assist] guild count: ${guilds.length}`); if (!guilds.length) logger.log('[forge-assist] serving 0 guilds'); for (const guild of guilds) logger.log(`[forge-assist] guild: ${guild.name} (${guild.id})`); return guilds; }
async function sendPrivateRedirect(message) { await message.reply('For privacy, please continue this conversation with Forge Assist in a direct message (DM).'); }
async function handleMessage(message, client, { logger = console, env = process.env } = {}) {
  logMessageDiagnostic(message, client, logger, env); if (!shouldRespond(message, client, env)) return { handled: false, reason: 'not_targeted' }; if (message.author?.bot) return { handled: false, reason: 'author_is_bot' }; if (processedMessageIds.has(message.id)) { logger.log('[forge-assist] duplicate message ignored'); return { handled: false, reason: 'duplicate' }; } processedMessageIds.add(message.id);
  if (!isDirectMessage(message)) { await sendPrivateRedirect(message); return { handled: true, reason: 'public_redirect' }; }
  const prompt = cleanPrompt(message, client); if (!prompt && !message.attachments?.size) { await message.reply('Hey! Ask me something and I’ll help.'); return { handled: true, reason: 'empty_prompt' }; }
  const privatePrompt = prompt || 'Please help with the attached file.';
  try { await message.channel.sendTyping(); const result = await askBackend(message, privatePrompt, env); saveTurn(keyFor(message), privatePrompt, result.response); archiveEvent(message, privatePrompt, true, result.provider, result.response); let first = true; for (const part of splitMessage(result.response)) { if (first) { await message.reply(part); first = false; } else await message.channel.send(part); } return { handled: true, reason: 'direct_message', provider: result.provider }; } catch (error) { console.error(`[forge-assist] message handling failed: ${error.message}`); archiveEvent(message, privatePrompt, false, 'unknown'); await message.reply('I’m temporarily unable to reach my AI backend. Please try again in a moment.').catch(replyError => console.error(`[forge-assist] reply failed: ${replyError.message}`)); return { handled: true, reason: 'backend_error' }; }
}
function registerMessageHandlers(client, { logger = console, env = process.env } = {}) { client.on('messageCreate', message => handleMessage(message, client, { logger, env })); return client; }
function createBot() { const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] }); client.once('ready', () => logGuildDiagnostics(client)); return registerMessageHandlers(client); }
async function startBot({ env = process.env, botFactory = createBot, logger = console } = {}) { const token = readDiscordToken(env); logTokenDiagnostic(token, logger); logChannelDiagnostic(readConfiguredChannelIds(env), logger); if (!token) throw new Error('DISCORD_TOKEN is required'); return botFactory().login(token); }
if (require.main === module) startBot().catch(error => { console.error(`[forge-assist] startup failed: ${error.message}`); process.exitCode = 1; });
module.exports = { createBot, startBot, logGuildDiagnostics, logMessageDiagnostic, registerMessageHandlers, handleMessage, splitMessage, shouldRespond, targetReason, conversations, archiveEvent, postArchive, archiveStats, _test: { processedMessageIds, sendPrivateRedirect, keyFor, isDirectMessage }, _internals: { askBackend, cleanPrompt, languageOf, getContext, saveTurn }, _resetForTests: () => { conversations.clear(); processedMessageIds.clear(); archivedEventIds.clear(); archiveStats.totalQueries = 0; archiveStats.successfulQueries = 0; archiveStats.failedQueries = 0; archiveStats.attachments = 0; archiveStats.providers = {}; archiveStats.languages = {}; } };

// End of source file.
