const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMessage } = require('../src/bot');
const { generateAnswer } = require('../src/backend/providers');

test('splitMessage preserves long responses within Discord limits', () => {
  const parts = splitMessage(`${'a'.repeat(1990)}\n${'b'.repeat(1990)}`);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 2000));
  assert.equal(parts.join('').length, 3980);
});

test('provider manager fails over to the next configured provider', async () => {
  const originalFetch = global.fetch;
  let groqBody;
  global.fetch = async (url, options) => {
    if (url.includes('anthropic')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
    groqBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback response' } }] }), { status: 200 });
  };
  try {
    const result = await generateAnswer({ prompt: 'hello', env: { CLAUDE_API_KEY: 'test', GROQ_API_KEY: 'test', AI_PROVIDER_ORDER: 'claude,groq', GROQ_BASE_URL: 'https://api.groq.com/openai/v1', AI_PROVIDER_TIMEOUT_MS: '1000' }, logger: { error() {} } });
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, 'fallback response');
    assert.equal(result.failures.length, 1);
    assert.equal(groqBody.messages[0].role, 'system');
    assert.match(groqBody.messages[0].content, /Forge Assist/);
  } finally { global.fetch = originalFetch; }
});

test('provider manager reports no providers without crashing', async () => {
  await assert.rejects(() => generateAnswer({ prompt: 'hello', env: {}, logger: { error() {} } }), /No AI providers/);
});
