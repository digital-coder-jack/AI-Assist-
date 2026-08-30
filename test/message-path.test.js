const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../src/bot/index');

function makeMessage(overrides = {}) {
  const replies = [];
  const sends = [];
  return {
    id: overrides.id || 'message-1',
    guildId: overrides.guildId === undefined ? 'guild-1' : overrides.guildId,
    channelId: overrides.channelId || 'forge-channel',
    createdAt: new Date(),
    author: { id: overrides.userId || 'user-1', username: 'user', bot: false, ...(overrides.author || {}) },
    content: overrides.content === undefined ? 'help me' : overrides.content,
    mentions: { has: () => Boolean(overrides.mentioned) },
    attachments: new Map(),
    channel: { sendTyping: async () => {}, send: async value => sends.push(value) },
    reply: async value => replies.push(value),
    replies,
    sends,
  };
}

function client() { return { user: { id: 'bot-id' } }; }

test('public configured-channel messages are redirected and never call the backend', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('backend must not be called'); };
  const message = makeMessage();
  const logs = [];
  const result = await bot.handleMessage(message, client(), { env: { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }, logger: { log(value) { logs.push(value); } } });
  assert.equal(result.reason, 'public_redirect');
  assert.equal(calls, 0);
  assert.deepEqual(message.replies, ['For privacy, please continue this conversation with Forge Assist in a direct message (DM).']);
  assert.equal(logs.some(value => value.includes('help me')), false);
  global.fetch = originalFetch;
});

test('direct messages reach /api/chat and reply only in the same DM', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ response: 'AI response', provider: 'groq' }) }; };
  const message = makeMessage({ id: 'dm-1', guildId: null, channelId: 'dm-channel', content: 'help me privately' });
  const result = await bot.handleMessage(message, client(), { env: { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logger: { log() {} } });
  assert.equal(result.reason, 'private_response');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.vercel.app/api/chat');
  assert.equal(JSON.parse(calls[0].options.body).message, 'help me privately');
  assert.deepEqual(message.replies, []);
  assert.deepEqual(message.sends, ['AI response']);
  global.fetch = originalFetch;
});

test('DM conversation keys are isolated by Discord user ID', () => {
  bot._resetForTests();
  const a = makeMessage({ guildId: null, channelId: 'dm-a', userId: 'user-a' });
  const b = makeMessage({ guildId: null, channelId: 'dm-b', userId: 'user-b' });
  assert.notEqual(bot._test.keyFor(a), bot._test.keyFor(b));
});

test('messages outside configured channel are ignored while direct mentions remain supported', () => {
  const other = makeMessage({ channelId: 'other-channel' });
  const mention = makeMessage({ channelId: 'other-channel', mentioned: true });
  assert.equal(bot.targetReason(other, client(), { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), 'not_targeted');
  assert.equal(bot.shouldRespond(other, client(), { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), false);
  assert.equal(bot.targetReason(mention, client(), { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), 'direct_mention');
  assert.equal(bot.shouldRespond(mention, client(), { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }), true);
});

test('bot messages are ignored and duplicate messages are not processed twice', async () => {
  bot._resetForTests();
  const botMessage = makeMessage({ author: { bot: true } });
  assert.equal((await bot.handleMessage(botMessage, client(), { env: { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }, logger: { log() {} } })).reason, 'author_is_bot');

  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ response: 'ok', provider: 'groq' }) }; };
  const dm = makeMessage({ id: 'duplicate-dm', guildId: null, channelId: 'dm-channel' });
  const options = { env: { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logger: { log() {} } };
  const first = await bot.handleMessage(dm, client(), options);
  const second = await bot.handleMessage(dm, client(), options);
  assert.equal(first.reason, 'private_response');
  assert.equal(second.reason, 'duplicate');
  assert.equal(calls, 1);
  global.fetch = originalFetch;
});
