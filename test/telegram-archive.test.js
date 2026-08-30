const test = require('node:test');
const assert = require('node:assert/strict');
const { config, chunk, questionText } = require('../src/backend/telegram-archive');

test('Telegram archive requires only the bot token and private destination', () => {
  assert.deepEqual(config({ TELEGRAM_BOT_TOKEN: 'x', FORGE_DATA_CENTER_2_CHAT_ID: '-1001' }), { token: 'x', chatId: '-1001' });
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: 'x' }), /not configured/);
});

test('Telegram archive chunks messages within Telegram limits', () => {
  assert.ok(chunk('x'.repeat(9000)).every(part => part.length <= 4096));
});

test('Telegram archive contains question and stable event metadata', () => {
  const text = questionText({ username: 'jack', userId: '123', guildId: '456', question: 'How do I deploy?', response: 'Use the deployment checklist.', language: 'English', provider: 'groq', timestamp: '2026-08-29T00:00:00Z', eventId: 'm1:success', attachments: [{ filename: 'guide.pdf' }] });
  assert.match(text, /jack/); assert.match(text, /How do I deploy/); assert.match(text, /Use the deployment checklist/); assert.match(text, /guide.pdf/); assert.match(text, /m1:success/);
});
