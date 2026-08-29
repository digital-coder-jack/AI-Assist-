const { Client, GatewayIntentBits, Partials } = require('discord.js');

const MAX_DISCORD_LENGTH = 2000;
const contextLimit = Math.max(2, Number(process.env.FORGE_ASSIST_CONTEXT_LIMIT || 12));
const conversations = new Map();

function keyFor(message) { return `${message.guildId || 'dm'}:${message.channelId}:${message.author.id}`; }
function configuredChannelIds() { return (process.env.FORGE_ASSIST_CHANNEL_IDS || '').split(',').map(x => x.trim()).filter(Boolean); }
function shouldRespond(message, client) {
  if (message.author.bot) return false;
  const mentioned = message.mentions.has(client.user);
  const repliedToBot = message.reference?.messageId && message.mentions.has(client.user);
  const channelAllowed = configuredChannelIds().includes(message.channelId);
  return mentioned || repliedToBot || channelAllowed;
}
function cleanPrompt(message, client) { return message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim(); }
function getContext(key) { return conversations.get(key) || []; }
function saveTurn(key, user, assistant) {
  const next = [...getContext(key), { role: 'user', content: user }, { role: 'assistant', content: assistant }];
  conversations.set(key, next.slice(-contextLimit));
}
function splitMessage(text) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > MAX_DISCORD_LENGTH) {
    let cut = remaining.lastIndexOf('\n', MAX_DISCORD_LENGTH);
    if (cut < 500) cut = remaining.lastIndexOf(' ', MAX_DISCORD_LENGTH);
    if (cut < 1) cut = MAX_DISCORD_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ['Forge Assist is temporarily unavailable.'];
}
async function askBackend(message, prompt) {
  const base = (process.env.FORGE_ASSIST_BACKEND_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('FORGE_ASSIST_BACKEND_URL is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.FORGE_ASSIST_REQUEST_TIMEOUT_MS || 25000));
  try {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-forge-assist-secret': process.env.FORGE_ASSIST_API_SECRET || '' }, body: JSON.stringify({ message: prompt, context: getContext(keyFor(message)) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.response !== 'string') throw new Error(data.message || `backend returned ${response.status}`);
    return data.response;
  } finally { clearTimeout(timer); }
}
function createBot() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
  client.once('ready', () => console.log(`[forge-assist] logged in as ${client.user.tag}`));
  client.on('messageCreate', async message => {
    if (!shouldRespond(message, client)) return;
    const prompt = cleanPrompt(message, client);
    if (!prompt) return message.reply('Hey! Ask me something and I’ll help.');
    try {
      await message.channel.sendTyping();
      const response = await askBackend(message, prompt);
      saveTurn(keyFor(message), prompt, response);
      let first = true;
      for (const chunk of splitMessage(response)) {
        if (first) { await message.reply(chunk); first = false; } else await message.channel.send(chunk);
      }
    } catch (error) {
      console.error(`[forge-assist] message handling failed: ${error.message}`);
      await message.reply('I’m temporarily unable to reach my AI backend. Please try again in a moment.').catch(replyError => console.error(`[forge-assist] reply failed: ${replyError.message}`));
    }
  });
  return client;
}

if (require.main === module) {
  if (!process.env.DISCORD_TOKEN) { console.error('[forge-assist] DISCORD_TOKEN is required'); process.exitCode = 1; }
  else createBot().login(process.env.DISCORD_TOKEN).catch(error => { console.error(`[forge-assist] startup failed: ${error.message}`); process.exitCode = 1; });
}
module.exports = { createBot, splitMessage, shouldRespond, conversations };
