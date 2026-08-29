const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore, recordEvent, recordAttachment } = require('../src/backend/data-center');

test('Data Center 2 records user statistics and question history', async () => {
  const store = createMemoryStore();
  await recordEvent(store, { guildId: 'g1', userId: 'u1', username: 'coder', question: 'bhai ye error kyu aa raha hai?', success: true, provider: 'groq', messageId: 'm1' });
  await recordEvent(store, { guildId: 'g1', userId: 'u1', username: 'coder', question: 'Why does this fail?', success: false, provider: 'claude', messageId: 'm2' });
  const data = await store.read(); const user = data.users['g1:u1'];
  assert.equal(user.totalQueries, 2); assert.equal(user.successfulQueries, 1); assert.equal(user.failedQueries, 1); assert.equal(user.languages.hinglish, 1); assert.equal(user.languages.english, 1); assert.equal(data.questions.length, 2); assert.equal(data.totals.providers.groq.success, 1);
});

test('Data Center 2 stores attachment bytes separately from metadata', async () => {
  const store = createMemoryStore();
  await recordEvent(store, { guildId: 'g1', userId: 'u1', username: 'coder', question: 'see this', success: true, provider: 'kimi', messageId: 'm1' });
  const attachment = await recordAttachment(store, { guildId: 'g1', userId: 'u1', messageId: 'm1', filename: 'screen.png', contentType: 'image/png', size: 3, body: Buffer.from('abc') });
  const data = await store.read();
  assert.equal(data.attachments.length, 1); assert.equal(data.attachments[0].filename, 'screen.png'); assert.equal(data.attachments[0].storageReference, 'memory://forge-assist/attachments/m1-screen.png'); assert.equal(data.users['g1:u1'].attachmentCount, 1); assert.equal(store._files.get(data.attachments[0].storageKey).body.toString(), 'abc'); assert.equal(attachment.contentType, 'image/png');
});
