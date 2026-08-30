const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../src/bot/index');
const { systemPrompt } = require('../src/backend/providers');

function publicMention(overrides = {}) {
  const publicReplies = [];
  const dmMessages = [];
  const dmChannel = { sendTyping: async () => {}, send: async value => dmMessages.push(value) };
  return {
    id: overrides.id || 'public-1', guildId: 'guild-1', channelId: 'forge-channel', content: '<@bot-id> bhai explain async await', createdAt: new Date(),
    author: { id: 'user-1', username: 'member', bot: false, send: async value => { dmMessages.push(value); return { channel: dmChannel }; } },
    mentions: { has: () => true }, attachments: new Map(),
    channel: { sendTyping: async () => {}, send: async () => {} },
    reply: async value => publicReplies.push(value), delete: async () => { overrides.deleted = true; },
    publicReplies, dmMessages, dmChannel, ...overrides,
  };
}

test('configured public mention is moved to DM, uses the original question, and never answers publicly', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  global.clearTimeout = () => {};
  let request;
  global.fetch = async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ response: 'Async/await keeps asynchronous code readable.', provider: 'groq' }) }; };
  const message = publicMention();
  const result = await bot.handleMessage(message, { user: { id: 'bot-id' } }, { env: { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel', FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logger: { log() {} } });
  assert.equal(result.reason, 'private_response');
  assert.equal(request.url, 'https://example.vercel.app/api/chat');
  assert.equal(JSON.parse(request.options.body).message, 'bhai explain async await');
  assert.equal(message.publicReplies.length, 0);
  assert.deepEqual(message.dmMessages, ['Hey! I\'ve moved this conversation to DM so your AI chat stays private.', 'Async/await keeps asynchronous code readable.']);
  assert.ok(timers.some(timer => timer.delay === 15000));
  global.fetch = originalFetch; global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout;
});

test('public mention attachments are forwarded into the private DM handoff and backend metadata', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ response: 'I can inspect that file.', provider: 'groq' }) }; };
  const message = publicMention({ attachments: new Map([['a', { id: 'a', name: 'screenshot.png', url: 'https://cdn.example/a', contentType: 'image/png', size: 42 }]]) });
  await bot.handleMessage(message, { user: { id: 'bot-id' } }, { env: { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel', FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logger: { log() {} } });
  assert.deepEqual(body.attachments, [{ id: 'a', filename: 'screenshot.png', contentType: 'image/png', size: 42 }]);
  assert.deepEqual(message.dmMessages[1], { files: [{ attachment: 'https://cdn.example/a', name: 'screenshot.png' }] });
  global.fetch = originalFetch;
});

test('DM failure gives a safe public notice and does not expose the question', async () => {
  bot._resetForTests();
  const replies = [];
  const message = publicMention({ author: { id: 'user-1', username: 'member', bot: false, send: async () => { throw new Error('Cannot send messages to this user'); } }, reply: async value => replies.push(value) });
  const result = await bot.handleMessage(message, { user: { id: 'bot-id' } }, { env: { FORGE_ASSIST_CHANNEL_IDS: 'forge-channel' }, logger: { log() {} } });
  assert.equal(result.reason, 'dm_failed');
  assert.deepEqual(replies, ['I could not start a private DM. Please check your Discord privacy settings and try again.']);
  assert.equal(replies.some(value => value.includes('async await')), false);
});

test('language detection and provider instruction preserve the user language and style', () => {
  assert.equal(bot._internals.languageOf('How does async await work?'), 'English');
  assert.equal(bot._internals.languageOf('bhai async await kaise kaam karta hai'), 'Hinglish');
  assert.equal(bot._internals.languageOf('यह कैसे काम करता है?'), 'Hindi');
  assert.match(systemPrompt(), /same language and conversational style/);
  assert.match(systemPrompt(), /Do not translate/);
});
