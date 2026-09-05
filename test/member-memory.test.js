const { test } = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../src/backend/member-memory');

test.beforeEach(() => memory.reset());

test('new member has no memory and explicit project context is stored', () => {
  assert.deepEqual(memory.retrieveMemory('user-1', 'what should I do next'), []);
  const result = memory.upsertFromPrompt('user-1', "I'm building a Discord bot.");
  assert.equal(result.results[0].stored, true);
  assert.match(memory.snapshot('user-1')[0].text, /Discord bot/);
});

test('relevant deployment memory is retrieved while unrelated Python memory is excluded', () => {
  memory.upsertFromPrompt('user-1', 'I am learning Python.');
  memory.upsertFromPrompt('user-1', 'Vercel pe deploy kar raha hoon.');
  const results = memory.retrieveMemory('user-1', 'ab deployment mein error aa raha hai');
  assert.equal(results.length, 1);
  assert.match(results[0].text, /Vercel/);
});

test('technical problem and follow-up context are retained explicitly', () => {
  memory.upsertFromPrompt('user-1', 'usme role assign karna hai');
  const results = memory.retrieveMemory('user-1', 'ab role assign nahi ho raha');
  assert.equal(results.length, 1);
  assert.match(results[0].text, /role assign/);
});

test('wahi reference with multiple plausible memories asks for clarification', () => {
  memory.upsertFromPrompt('user-1', "I'm building a Discord bot.");
  memory.upsertFromPrompt('user-1', 'Vercel pe deploy kar raha hoon.');
  const resolved = memory.resolveMemory('user-1', 'bhai wahi project');
  assert.equal(resolved.status, 'ambiguous');
  assert.equal(resolved.items.length, 2);
});

test('duplicate memory updates an existing item instead of creating another', () => {
  memory.upsertFromPrompt('user-1', 'I am learning JavaScript.');
  const updated = memory.upsertFromPrompt('user-1', 'I am learning JavaScript.');
  assert.equal(updated.results[0].updated, true);
  assert.equal(memory.snapshot('user-1').length, 1);
});

test('sensitive information is never stored', () => {
  const result = memory.upsertFromPrompt('user-1', 'My API key is secret-token-123 and I am building a bot.');
  assert.equal(result.results, undefined);
  assert.deepEqual(memory.snapshot('user-1'), []);
});

test('explicit forget request removes relevant memory without affecting another member', () => {
  memory.upsertFromPrompt('user-1', "I'm building a Discord bot.");
  memory.upsertFromPrompt('user-1', 'I am learning Python.');
  memory.upsertFromPrompt('user-2', "I'm building a Discord bot.");
  const forgotten = memory.forgetMemory('user-1', 'forget my Discord bot memory');
  assert.equal(forgotten.removed, 1);
  assert.equal(memory.snapshot('user-1').length, 1);
  assert.equal(memory.snapshot('user-2').length, 1);
});

test('forget all is explicit and scoped to the requesting Discord user ID', () => {
  memory.upsertFromPrompt('user-1', 'I am learning Python.');
  memory.upsertFromPrompt('user-1', 'Vercel pe deploy kar raha hoon.');
  memory.upsertFromPrompt('user-2', 'I am learning Python.');
  const forgotten = memory.forgetMemory('user-1', 'forget everything you remember');
  assert.equal(forgotten.removed, 2);
  assert.equal(memory.snapshot('user-1').length, 0);
  assert.equal(memory.snapshot('user-2').length, 1);
});
