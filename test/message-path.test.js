const test = require('node:test');
const assert = require('node:assert/strict');
const { registerMessageHandlers, shouldRespond, targetReason } = require('../src/bot/index');

test('normal message in configured Forge Assist channel reaches /api/chat and replies', async () => {
  const originalFetch = global.fetch;
  const originalBackend = process.env.FORGE_ASSIST_BACKEND_URL;
  const originalSecret = process.env.FORGE_ASSIST_API_SECRET;
  process.env.FORGE_ASSIST_BACKEND_URL = 'https://example.vercel.app';
  process.env.FORGE_ASSIST_API_SECRET = 'test-secret';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ response: 'AI response', provider: 'test' }) };
  };
  const logs = [];
  const client = { user: { id: 'bot-id' }, on(event, handler) { this.handler = handler; assert.equal(event, 'messageCreate'); } };
  registerMessageHandlers(client, { logger: { log: value => logs.push(value) }, env: { ...process.env, FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' } });
  const replies = [];
  const sends = [];
  const message = {
    id: 'message-1', guildId: 'guild-1', channelId: 'forge-channel', createdAt: new Date(),
    author: { id: 'user-1', username: 'user', bot: false }, content: 'help me',
    mentions: { has: () => false }, attachments: new Map(), reference: null,
    channel: { sendTyping: async () => {}, send: async value => sends.push(value) },
    reply: async value => replies.push(value)
  };
  assert.equal(targetReason(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), 'configured_channel');
  assert.equal(shouldRespond(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), true);
  await client.handler(message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.vercel.app/api/chat');
  assert.equal(JSON.parse(calls[0].options.body).message, 'help me');
  assert.deepEqual(replies, ['AI response']);
  assert.deepEqual(sends, []);
  assert.match(logs[0], /message received: guild=guild-1 channel=forge-channel authorBot=false targeted=true reason=configured_channel/);
  global.fetch = originalFetch;
  if (originalBackend === undefined) delete process.env.FORGE_ASSIST_BACKEND_URL; else process.env.FORGE_ASSIST_BACKEND_URL = originalBackend;
  if (originalSecret === undefined) delete process.env.FORGE_ASSIST_API_SECRET; else process.env.FORGE_ASSIST_API_SECRET = originalSecret;
});

test('direct mention remains supported outside configured channel', () => {
  const client = { user: { id: 'bot-id' } };
  const message = { channelId: 'other-channel', author: { bot: false }, content: '<@bot-id> help', mentions: { has: user => user.id === 'bot-id' }, reference: null };
  assert.equal(targetReason(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), 'direct_mention');
  assert.equal(shouldRespond(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), true);
});

test('ordinary message outside configured channel is ignored', () => {
  const client = { user: { id: 'bot-id' } };
  const message = { channelId: 'other-channel', author: { bot: false }, content: 'hello', mentions: { has: () => false }, reference: null };
  assert.equal(targetReason(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), 'not_targeted');
  assert.equal(shouldRespond(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), false);
});

test('bot messages remain ignored even in configured channel', () => {
  const client = { user: { id: 'bot-id' } };
  const message = { channelId: 'forge-channel', author: { bot: true }, mentions: { has: () => false }, reference: null };
  assert.equal(targetReason(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), 'author_is_bot');
  assert.equal(shouldRespond(message, client, { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), false);
});
