const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../src/bot');

function event(eventId = 'archive-test-1') {
  return { eventId, userId: 'user-1', question: 'private question should never be logged', response: 'private response should never be logged' };
}

function logger() {
  const lines = [];
  return { lines, log(value) { lines.push(String(value)); } };
}

test('archive POST is attempted without Wispbyte Telegram variables and normalizes a trailing slash', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  const calls = [];
  const logs = logger();
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 202 }; };
  try {
    const result = await bot.postArchive(event(), { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app/', FORGE_ASSIST_API_SECRET: 'synthetic-secret' }, logs);
    assert.deepEqual(result, { archived: true, status: 202 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.vercel.app/api/assist/events');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(JSON.parse(calls[0].options.body).eventId, 'archive-test-1');
    assert.match(logs.lines.join('\n'), /archive POST status: 202/);
    assert.doesNotMatch(logs.lines.join('\n'), /private question|private response|synthetic-secret|TELEGRAM_BOT_TOKEN|API_KEY/);
  } finally { global.fetch = originalFetch; }
});

test('archive POST is skipped only for missing backend URL or an already archived event', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  let calls = 0;
  const logs = logger();
  global.fetch = async () => { calls += 1; return { ok: true, status: 202 }; };
  try {
    const missing = await bot.postArchive(event('missing-url'), {}, logs);
    assert.deepEqual(missing, { archived: false, skipped: 'backend_url_missing' });
    assert.equal(calls, 0);
    assert.match(logs.lines.join('\n'), /backend URL is missing/);

    const first = await bot.postArchive(event('duplicate-event'), { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logs);
    const duplicate = await bot.postArchive(event('duplicate-event'), { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logs);
    assert.deepEqual(first, { archived: true, status: 202 });
    assert.deepEqual(duplicate, { archived: false, skipped: 'already_archived' });
    assert.equal(calls, 1);
    assert.match(logs.lines.join('\n'), /event already archived/);
  } finally { global.fetch = originalFetch; }
});

test('archive HTTP failures log only the status and allow a retry', async () => {
  bot._resetForTests();
  const originalFetch = global.fetch;
  const logs = logger();
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 503 }; };
  try {
    const result = await bot.postArchive(event('retry-event'), { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logs);
    const retry = await bot.postArchive(event('retry-event'), { FORGE_ASSIST_BACKEND_URL: 'https://example.vercel.app' }, logs);
    assert.deepEqual(result, { archived: false, status: 503 });
    assert.deepEqual(retry, { archived: false, status: 503 });
    assert.equal(calls, 2);
    assert.match(logs.lines.join('\n'), /archive POST failed: HTTP 503/);
    assert.doesNotMatch(logs.lines.join('\n'), /question|response|token|secret|api_key/i);
  } finally { global.fetch = originalFetch; }
});
