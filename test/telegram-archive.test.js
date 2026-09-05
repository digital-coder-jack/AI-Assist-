const test = require('node:test');
const assert = require('node:assert/strict');
const { config, chunk, archiveRecord, parseArchiveRecord, normalizeContent, memberRecordText, sessionRecordText, queryRecordText, conversationRecordText, statsText, memoryRecordText } = require('../src/backend/telegram-archive');

test('Telegram archive requires only the bot token and private destination', () => {
  assert.deepEqual(config({ TELEGRAM_BOT_TOKEN: 'x', FORGE_DATA_CENTER_2_CHAT_ID: '-1001' }), { token: 'x', chatId: '-1001' });
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: 'x' }), /not configured/);
});

test('Telegram archive chunks messages within Telegram limits', () => {
  assert.ok(chunk('x'.repeat(9000)).every(part => part.length <= 4096));
});

test('Telegram records are human-readable, identity-scoped, and secret-safe', () => {
  const event = { userId: '123', username: 'jack', displayName: 'Jack', guildId: '456', channelId: '789', sessionId: 'session:dm:123', mode: 'private_dm', timestamp: '2026-08-29T00:00:00Z', question: 'How do I deploy?', response: 'Use the deployment checklist.', language: 'English', provider: 'groq', eventId: 'm1:success' };
  const member = memberRecordText({ ...event, memberEventType: 'MEMBER_CREATED' });
  const session = sessionRecordText({ ...event, sessionEventType: 'SESSION_STARTED' });
  const query = queryRecordText({ ...event, success: true });
  const conversation = conversationRecordText({ ...event, success: true });
  const stats = statsText({ ...event, totalQueries: 1, successfulQueries: 1, failedQueries: 0, activeConversations: 1, contextMessageCount: 2 });
  for (const text of [member, session, query, conversation, stats]) { assert.match(text, /FORGE ASSIST/); assert.match(text, /Discord ID: 123/); assert.doesNotMatch(text, /DISCORD_TOKEN|API_KEY|TELEGRAM_BOT_TOKEN/); }
  assert.match(member, /Community Member Record/);
  assert.match(session, /Session Record/);
  assert.match(query, /Query Record/);
  assert.match(conversation, /Conversation Record/);
  assert.match(stats, /System Event Record/);
  assert.match(query, /Status: ✅ Successful/);
  const memory = memoryRecordText({ eventId: 'memory-1', userId: '123', username: 'jack', guildId: '456', timestamp: '2026-08-29T00:00:00Z', memoryAction: 'UPSERT', memory: { id: 'm-1', text: 'I am building a Discord bot.', topics: ['discord', 'bot'] } });
  assert.match(memory, /Member Memory Record/);
  assert.match(memory, /I am building a Discord bot/);
  assert.doesNotMatch(memory, /TELEGRAM_BOT_TOKEN|API_KEY/);
});

test('Telegram archive record format can be read from an already-supplied archive message without inventing history retrieval', () => {
  const text = archiveRecord('MEMBER_CREATED', { discord_user_id: '123', first_seen_at: '2026-08-29T00:00:00Z' });
  const fields = parseArchiveRecord(text);
  assert.equal(fields.record_type, 'MEMBER_CREATED');
  assert.equal(fields.discord_user_id, '123');
  assert.equal(fields.first_seen_at, '2026-08-29T00:00:00Z');
});

test('Telegram content normalization converts escaped newlines and HTML breaks without unsafe rendering', () => {
  assert.equal(normalizeContent('one\\ntwo<br>three\\r\\nfour'), 'one\ntwo\nthree\nfour');
  const text = queryRecordText({ eventId: 'q-1', userId: 'u-1', question: 'What?\\nNext', response: 'Answer<br>Next', success: true, timestamp: '2026-09-02T13:36:00Z' });
  assert.match(text, /What\?\nNext/);
  assert.match(text, /Answer\nNext/);
  assert.doesNotMatch(text, /<br>/i);
});

test('Telegram archive writes member, session, query, conversation, and system records to the configured destination', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; };
  const event = { eventId: 'evt-1', messageId: 'msg-1', memberEventType: 'MEMBER_CREATED', sessionEventType: 'SESSION_STARTED', userId: 'user-1', username: 'member', guildId: 'guild-1', channelId: 'channel-1', sessionId: 'session:dm:user-1', mode: 'private_dm', timestamp: '2026-08-29T00:00:00Z', question: 'How do I deploy?', response: 'Use the deployment checklist.', success: true, language: 'English', provider: 'groq', totalQueries: 1, successfulQueries: 1, failedQueries: 0, activeConversations: 1, contextMessageCount: 2, attachments: [] };
  try {
    await require('../src/backend/telegram-archive').archiveEvent(event, { TELEGRAM_BOT_TOKEN: 'synthetic-test-token', FORGE_DATA_CENTER_2_CHAT_ID: '-1001' });
    assert.equal(requests.length, 5);
    const text = requests.map(request => request.body.text).filter(Boolean).join('\n');
    assert.match(text, /Community Member Record/);
    assert.match(text, /Session Record/);
    assert.match(text, /Query Record/);
    assert.match(text, /Conversation Record/);
    assert.match(text, /System Event Record/);
    assert.doesNotMatch(text, /synthetic-test-token/);
  } finally { global.fetch = originalFetch; }
});
