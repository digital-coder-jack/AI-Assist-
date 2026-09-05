const test = require('node:test');
const assert = require('node:assert/strict');
const contactApi = require('../api/assist/contact');
const bot = require('../src/bot');

function response() { return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } }; }
function event(overrides = {}) { return { eventId: 'contact:message-1', messageId: 'message-1', sessionId: 'contact:dm:user-1', userId: 'user-1', username: 'member', displayName: 'Member', discordChannelId: 'channel-1', message: 'Can I suggest a new channel?', ...overrides }; }
function env(overrides = {}) { return { ...process.env, FORGE_ASSIST_API_SECRET: 'secret', TELEGRAM_CONTACT_BOT_TOKEN: 'contact-token', TELEGRAM_OWNER_CHAT_ID: '9001', TELEGRAM_BOT_TOKEN: 'data-token', FORGE_DATA_CENTER_2_CHAT_ID: '-1001', ...overrides }; }

function installFetch() {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) }; };
  return { calls, restore: () => { global.fetch = original; } };
}

test.afterEach(() => { contactApi._test.reset(); bot._resetForTests(); });

test('contact API creates a stable request, forwards to the owner, and archives a compact Data Center record', async () => {
  const mock = installFetch();
  const previous = { ...process.env };
  Object.assign(process.env, env());
  try {
    const res = response();
    await contactApi({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: event() }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.delivered, true);
    assert.match(res.body.requestId, /^FA-REQ-[A-Z0-9]+$/);
    assert.match(mock.calls[0].body.text, /OWNER CONTACT/);
    assert.match(mock.calls.at(-1).body.text, /Contact Request/);
    assert.doesNotMatch(mock.calls.map(call => JSON.stringify(call.body)).join('\n'), /contact-token|data-token|secret/);
  } finally { global.fetch = mock.restore(); process.env = previous; }
});

test('contact API suppresses duplicate event forwarding and accepts missing optional Discord metadata', async () => {
  const mock = installFetch();
  const previous = { ...process.env };
  Object.assign(process.env, env());
  try {
    const first = response(); const second = response();
    const minimal = event({ guildId: null, guildName: null, channelName: null });
    await contactApi({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: minimal }, first);
    await contactApi({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: minimal }, second);
    assert.equal(first.body.delivered, true);
    assert.deepEqual(second.body, { delivered: true, duplicate: true, requestId: first.body.requestId });
  } finally { global.fetch = mock.restore(); process.env = previous; }
});

test('Discord contact command acknowledges only after backend delivery succeeds', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 202, json: async () => ({ delivered: true, requestId: 'FA-REQ-ABC12345' }) }; };
  const sent = [];
  const message = { id: 'message-1', content: '/contact Please help me.', guildId: null, channelId: 'dm-1', author: { id: 'user-1', username: 'member', bot: false }, mentions: { has: () => false }, channel: { send: async text => sent.push(text) } };
  try {
    const result = await bot.handleMessage(message, { user: { id: 'bot-id' } }, { env: { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app', FORGE_ASSIST_API_SECRET: 'secret' }, logger: { log() {} } });
    assert.equal(result.reason, 'owner_contact_sent');
    assert.equal(calls[0].url, 'https://example.vercel.app/api/assist/contact');
    assert.match(calls[0].body.message, /Please help me/);
    assert.match(sent[0], /FA-REQ-ABC12345/);
  } finally { global.fetch = original; }
});

test('contact API rate-limits repeated messages without affecting other users', () => {
  contactApi._test.reset();
  const firstUser = Array.from({ length: 8 }, () => contactApi._test.rateAllowed('user-rate', Date.now()));
  assert.deepEqual(firstUser, [true, true, true, true, true, true, true, true]);
  assert.equal(contactApi._test.rateAllowed('user-rate', Date.now()), false);
  assert.equal(contactApi._test.rateAllowed('other-user', Date.now()), true);
});

test('Discord contact delivery failure does not claim success', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'contact_delivery_unavailable' }) });
  const sent = [];
  const message = { id: 'message-2', content: '/contact Retry later', guildId: null, channelId: 'dm-1', author: { id: 'user-2', username: 'member', bot: false }, mentions: { has: () => false }, channel: { send: async text => sent.push(text) } };
  try {
    const result = await bot.handleMessage(message, { user: { id: 'bot-id' } }, { env: { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app', FORGE_ASSIST_API_SECRET: 'secret' }, logger: { log() {} } });
    assert.equal(result.reason, 'owner_contact_failed');
    assert.match(sent[0], /could not deliver/);
    assert.doesNotMatch(sent[0], /sent to the owner/);
  } finally { global.fetch = original; }
});

