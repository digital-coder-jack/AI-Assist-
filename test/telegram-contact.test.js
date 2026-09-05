const test = require('node:test');
const assert = require('node:assert/strict');
const contact = require('../src/backend/telegram-contact');

const env = { TELEGRAM_CONTACT_BOT_TOKEN: 'contact-token', TELEGRAM_OWNER_CHAT_ID: '9001', FORGE_ASSIST_API_SECRET: 'secret' };
function request() { return { requestId: 'FA-REQ-ABC12345', discordUserId: 'user-1', discordChannelId: 'channel-1', discordMessageId: 'message-1', sessionId: 'contact:dm:user-1', createdAt: new Date().toISOString(), username: 'member', displayName: 'Member', guildId: 'guild-1', guildName: 'Developer Forge', channelName: 'general', status: 'WAITING_FOR_OWNER' }; }

function mockTelegram() {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) }; };
  return { calls, restore: () => { global.fetch = original; } };
}

test.afterEach(() => contact.resetForTests());

test('contact request IDs and signed routes are stable and tamper-resistant', () => {
  assert.equal(contact.requestId('contact:dm:user-1'), contact.requestId('contact:dm:user-1'));
  const token = contact.encodeRoute(request(), env.FORGE_ASSIST_API_SECRET);
  assert.deepEqual(contact.decodeRoute(token, env.FORGE_ASSIST_API_SECRET).requestId, 'FA-REQ-ABC12345');
  assert.throws(() => contact.decodeRoute(`${token}x`, env.FORGE_ASSIST_API_SECRET), /invalid contact route/);
});

test('owner authorization uses only the configured numeric Telegram chat ID', () => {
  assert.equal(contact.isOwnerChat('9001', env), true);
  assert.equal(contact.isOwnerChat(9002, env), false);
  assert.equal(contact.isOwnerChat('owner-name', env), false);
});

test('owner message forwarding uses clean human-readable text and owner controls', async () => {
  const mock = mockTelegram();
  try {
    await contact.sendOwnerMessage(request(), 'Hello\\nI need help<br>please.', env);
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].body.text, /OWNER CONTACT/);
    assert.match(mock.calls[0].body.text, /FA-REQ-ABC12345/);
    assert.match(mock.calls[0].body.text, /Hello\nI need help\nplease\./);
    assert.equal(mock.calls[0].body.reply_markup.inline_keyboard[0][0].text, '↩️ Reply');
    assert.match(mock.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, /^reply:/);
    assert.doesNotMatch(mock.calls[0].body.text, /contact-token|schema_version|raw JSON/);
  } finally { mock.restore(); }
});

test('unauthorized Telegram callback is rejected without leaking request data', async () => {
  const mock = mockTelegram();
  try {
    const result = await contact.answerCallback({ callback_query: { id: 'cb-1', data: 'close:any', message: { chat: { id: '9002' }, message_id: 4 } } }, env);
    assert.deepEqual(result, { handled: false, reason: 'unauthorized' });
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});

test('owner reply maps through the signed request route and prevents duplicate Telegram updates', async () => {
  const mock = mockTelegram();
  const route = contact.encodeRoute(request(), env.FORGE_ASSIST_API_SECRET);
  const delivered = [];
  try {
    const callback = await contact.answerCallback({ callback_query: { id: 'cb-1', data: `reply:${route}`, message: { chat: { id: '9001' }, message_id: 4 } } }, env);
    assert.equal(callback.handled, true);
    const prompt = mock.calls.at(-1).body.text;
    const update = { message: { message_id: 10, chat: { id: 9001 }, text: 'Sure, I can help.', reply_to_message: { text: prompt } } };
    const result = await contact.ownerReply(update, env, async (payload, text) => delivered.push({ payload, text }));
    assert.equal(result.handled, true);
    assert.equal(delivered[0].payload.discordUserId, 'user-1');
    assert.equal(delivered[0].payload.discordChannelId, 'channel-1');
    assert.equal(delivered[0].text, 'Sure, I can help.');
    const duplicate = await contact.ownerReply(update, env, async () => { throw new Error('must not deliver twice'); });
    assert.deepEqual(duplicate, { handled: false, reason: 'duplicate_owner_message' });
  } finally { mock.restore(); }
});

test('owner reply delivery failures remain retryable without duplicate success', async () => {
  const mock = mockTelegram();
  const route = contact.encodeRoute(request(), env.FORGE_ASSIST_API_SECRET);
  let attempts = 0;
  try {
    await contact.answerCallback({ callback_query: { id: 'cb-retry', data: `reply:${route}`, message: { chat: { id: 9001 }, message_id: 4 } } }, env);
    const prompt = mock.calls.at(-1).body.text;
    const update = { message: { message_id: 12, chat: { id: 9001 }, text: 'retry me', reply_to_message: { text: prompt } } };
    const first = await contact.ownerReply(update, env, async () => { attempts += 1; throw new Error('offline'); });
    assert.deepEqual(first, { handled: false, reason: 'discord_delivery_failed' });
    const second = await contact.ownerReply(update, env, async () => { attempts += 1; });
    assert.equal(second.handled, true);
    assert.equal(attempts, 2);
  } finally { mock.restore(); }
});

test('closing a request prevents later replies and callback retries are idempotent', async () => {
  const mock = mockTelegram();
  const route = contact.encodeRoute(request(), env.FORGE_ASSIST_API_SECRET);
  try {
    const update = { callback_query: { id: 'cb-close', data: `close:${route}`, message: { chat: { id: 9001 }, message_id: 4 } } };
    assert.equal((await contact.answerCallback(update, env)).action, 'close');
    assert.deepEqual(await contact.answerCallback(update, env), { handled: false, reason: 'duplicate_callback' });
    const prompt = { text: `↩️ Reply mode for FA-REQ-ABC12345.\nRouting token: ${route}` };
    const result = await contact.ownerReply({ message: { message_id: 11, chat: { id: 9001 }, text: 'late', reply_to_message: prompt } }, env, async () => { throw new Error('must not deliver'); });
    assert.deepEqual(result, { handled: false, reason: 'closed_request' });
  } finally { mock.restore(); }
});

test('message size and rate limits prevent abuse without exposing secrets', () => {
  assert.throws(() => contact.cleanMessage('x'.repeat(contact.MAX_CONTACT_MESSAGE_LENGTH + 1)), /too long/);
  assert.equal(contact.cleanMessage('one\\ntwo<br>three'), 'one\ntwo\nthree');
  const times = Array.from({ length: 8 }, (_, index) => contact._test.processedOwnerMessageIds.add(`x-${index}`));
  assert.equal(times.length, 8);
});

