const test = require('node:test');
const assert = require('node:assert/strict');
const retrieval = require('../src/backend/retrieval');
const chat = require('../api/chat');

function response() { return { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } }; }

test('language detection preserves English, Hindi, Roman Hinglish, and mixed style', () => {
  assert.equal(retrieval.detectLanguageStyle('What is recursion?').language, 'English');
  assert.equal(retrieval.detectLanguageStyle('यह कैसे काम करता है?').language, 'Hindi');
  assert.equal(retrieval.detectLanguageStyle('bhai ye bot kaise kaam karta hai').language, 'Hinglish');
  assert.equal(retrieval.detectLanguageStyle('भाई latest update kya hai').language, 'Mixed Hindi-English');
});

test('stable general questions do not trigger web search while current questions do', () => {
  assert.equal(retrieval.routeQuestion('What is recursion?', {}).webNeeded, false);
  assert.equal(retrieval.routeQuestion('What is the latest JavaScript release?', {}).webNeeded, true);
  assert.equal(retrieval.routeQuestion('search online for current Vercel pricing', {}).webNeeded, true);
});

test('community routing uses explicit data and never treats roles as personal attributes', () => {
  const community = retrieval.sanitizeCommunity({ guild: { name: 'Developer Forge' }, channel: { name: 'general', topic: 'Public discussion' }, publicRoles: ['Moderators'] });
  assert.equal(retrieval.routeQuestion('Developer Forge kya hai?', community).communityNeeded, true);
  const formatted = retrieval.formatCommunity(community);
  assert.match(formatted, /Developer Forge/);
  assert.match(formatted, /not personal attributes/i);
  assert.doesNotMatch(formatted, /gender|religion|location/i);
});

test('Brave search integration is mocked, bounded, and secret-safe', async () => {
  const calls = [];
  const result = await retrieval.searchWeb('latest JavaScript release', { env: { WEB_SEARCH_ENABLED: 'true', BRAVE_SEARCH_API_KEY: 'brave-secret', WEB_SEARCH_TIMEOUT_MS: '1000' }, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, json: async () => ({ web: { results: [{ title: 'Release', url: 'https://example.com/release', description: 'A current release.' }, { title: 'Bad', url: 'not-a-url', description: 'drop' }] } }) }; } });
  assert.equal(result.reason, 'ok');
  assert.equal(result.results.length, 1);
  assert.match(calls[0].url, /q=latest\+JavaScript\+release/);
  assert.equal(calls[0].options.headers['x-subscription-token'], 'brave-secret');
});

test('search-disabled, missing-key, timeout, and empty-result paths are safe', async () => {
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'false' } })).reason, 'disabled');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true' } })).reason, 'api_key_missing');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true', BRAVE_SEARCH_API_KEY: 'x', WEB_SEARCH_TIMEOUT_MS: '1' }, fetchImpl: async () => { const error = new Error('timeout'); error.name = 'AbortError'; throw error; } })).reason, 'timeout');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true', BRAVE_SEARCH_API_KEY: 'x' }, fetchImpl: async () => ({ ok: true, json: async () => ({ web: { results: [] } }) }) })).reason, 'empty');
});

test('grounded preparation combines community and mocked web sources without live internet', async () => {
  const community = { guild: { name: 'Developer Forge' }, channel: { name: 'general', topic: 'AI discussion' }, publicRoles: ['Builders'] };
  const prepared = await retrieval.prepareRequest({ prompt: 'Developer Forge me latest AI tools kya hain?', context: [], community, env: { WEB_SEARCH_ENABLED: 'true', BRAVE_SEARCH_API_KEY: 'brave-secret' }, fetchImpl: async () => ({ ok: true, json: async () => ({ web: { results: [{ title: 'Current source', url: 'https://example.com/current', description: 'Current public information.' }] } }) }) });
  assert.equal(prepared.route.source, 'COMMUNITY + WEB');
  assert.equal(prepared.language.language, 'Hinglish');
  assert.match(prepared.prompt, /Developer Forge/);
  assert.match(prepared.prompt, /Current source/);
  assert.match(prepared.prompt, /not personal attributes/);
});

test('chat backend preserves existing provider flow and returns source-aware metadata', async () => {
  const originalFetch = global.fetch;
  const previous = { ...process.env };
  Object.assign(process.env, { FORGE_ASSIST_API_SECRET: 'secret', WEB_SEARCH_ENABLED: 'false', GROQ_API_KEY: 'groq-secret', AI_PROVIDER_ORDER: 'groq' });
  global.fetch = async (url, options) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Haan bhai, available community info ke according...' } }] }) });
  try {
    const res = response();
    await chat({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: { message: 'Developer Forge kya hai?', context: [], community: { guild: { name: 'Developer Forge' } } } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.route, 'COMMUNITY');
    assert.equal(res.body.language, 'Hinglish');
    assert.deepEqual(res.body.sources, []);
  } finally { global.fetch = originalFetch; process.env = previous; }
});

