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

test('Tavily search integration is mocked, bounded, ranked, and secret-safe', async () => {
  const calls = [];
  const result = await retrieval.searchWeb('latest JavaScript release', { env: { WEB_SEARCH_ENABLED: 'true', TAVILY_API_KEY: 'tavily-secret', WEB_SEARCH_TIMEOUT_MS: '1000' }, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, json: async () => ({ results: [{ title: 'Lower', url: 'https://example.com/lower', content: 'Lower result.', score: 0.2 }, { title: 'Higher', url: 'https://example.com/higher', content: 'Higher result.', score: 0.9 }, { title: 'Bad', url: 'not-a-url', content: 'drop', score: 1 }] }) }; } });
  assert.equal(result.reason, 'ok');
  assert.equal(result.provider, 'tavily');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, 'Higher');
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].options.headers.authorization, 'Bearer tavily-secret');
  assert.equal(JSON.parse(calls[0].options.body).max_results, 5);
});

test('search-disabled, missing-key, timeout, and empty-result paths are safe', async () => {
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'false' } })).reason, 'disabled');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true' } })).reason, 'api_key_missing');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true', TAVILY_API_KEY: 'x', WEB_SEARCH_TIMEOUT_MS: '1' }, fetchImpl: async () => { const error = new Error('timeout'); error.name = 'AbortError'; throw error; } })).reason, 'timeout');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true', TAVILY_API_KEY: 'x' }, fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) })).reason, 'empty');
  assert.equal((await retrieval.searchWeb('latest news', { env: { WEB_SEARCH_ENABLED: 'true', TAVILY_API_KEY: 'x' }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }) })).reason, 'failed');
});

test('grounded preparation combines community and mocked web sources without live internet', async () => {
  const community = { guild: { name: 'Developer Forge' }, channel: { name: 'general', topic: 'AI discussion' }, publicRoles: ['Builders'] };
  const prepared = await retrieval.prepareRequest({ prompt: 'Developer Forge me latest AI tools kya hain?', context: [], memory: { status: 'resolved', items: [{ text: 'I am building a Discord bot.', topics: ['discord', 'bot'], relevance: 0.7 }] }, community, env: { WEB_SEARCH_ENABLED: 'true', TAVILY_API_KEY: 'tavily-secret' }, fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ title: 'Current source', url: 'https://example.com/current', content: 'Current public information.', score: 0.8 }] }) }) });
  assert.equal(prepared.route.source, 'COMMUNITY + WEB');
  assert.equal(prepared.language.language, 'Hinglish');
  assert.match(prepared.prompt, /Developer Forge/);
  assert.match(prepared.prompt, /Current source/);
  assert.match(prepared.prompt, /not personal attributes/);
  assert.match(prepared.prompt, /I am building a Discord bot/);
  assert.doesNotMatch(prepared.prompt, /Telegram Data Center|memory metadata/i);
});

test('exact Hinglish self-description request is Forge Assist identity-safe', async () => {
  const prompt = 'Acha toh aap apne baare mai kuch bataye';
  assert.equal(retrieval.identityIntent(prompt), 'introduction');
  const language = retrieval.detectLanguageStyle(prompt).language;
  const answer = retrieval.identityResponse('introduction', language);
  assert.equal(language, 'Hinglish');
  assert.match(answer, /Forge Assist/);
  assert.match(answer, /Developer Forge/);
  assert.match(answer, /Jack/);
  assert.doesNotMatch(answer, /GPT|OpenAI|ChatGPT|Claude|Groq|Kimi|training|trained|2023|cutoff/i);
});

test('identity intent and localized responses avoid provider identity leakage', () => {
  assert.equal(retrieval.identityIntent('Who are you?'), 'introduction');
  assert.match(retrieval.identityResponse('introduction', 'English'), /Forge Assist/);
  assert.match(retrieval.identityResponse('introduction', 'Hinglish'), /Developer Forge/);
  assert.match(retrieval.identityResponse('creator', 'English'), /Jack/);
  assert.doesNotMatch(retrieval.identityResponse('creator', 'English'), /trained OpenAI|created Claude/i);
  assert.equal(retrieval.identityIntent('Are you ChatGPT?'), 'provider');
  assert.equal(retrieval.identityIntent('Which model are you using?'), 'provider');
  assert.doesNotMatch(retrieval.identityResponse('provider', 'English', 'groq'), /I am ChatGPT|I am OpenAI/i);
});

test('chat backend answers the exact Hinglish identity case before any provider call', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, { FORGE_ASSIST_API_SECRET: 'secret', WEB_SEARCH_ENABLED: 'false', GROQ_API_KEY: '', KIMI_API_KEY: '', CLAUDE_API_KEY: '' });
  try {
    const result = response();
    await chat({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: { message: 'Acha toh aap apne baare mai kuch bataye' } }, result);
    assert.equal(result.statusCode, 200);
    assert.match(result.body.response, /Forge Assist/);
    assert.match(result.body.response, /Developer Forge/);
    assert.doesNotMatch(result.body.response, /GPT|OpenAI|ChatGPT|Claude|Groq|Kimi|training|2023/i);
  } finally { process.env = previous; }
});

test('chat backend answers identity questions directly and provider questions accurately', async () => {
  const original = { ...process.env };
  Object.assign(process.env, { FORGE_ASSIST_API_SECRET: 'secret', WEB_SEARCH_ENABLED: 'false', GROQ_API_KEY: '', KIMI_API_KEY: '', CLAUDE_API_KEY: '' });
  try {
    const intro = response();
    await chat({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: { message: 'Who are you?' } }, intro);
    assert.equal(intro.statusCode, 200);
    assert.match(intro.body.response, /Forge Assist/);
    assert.match(intro.body.response, /Developer Forge/);
    const creator = response();
    await chat({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: { message: 'Who made you?' } }, creator);
    assert.equal(creator.statusCode, 200);
    assert.match(creator.body.response, /Jack/);
  } finally { process.env = original; }
  const previous = { ...process.env };
  const originalFetch = global.fetch;
  Object.assign(process.env, { FORGE_ASSIST_API_SECRET: 'secret', WEB_SEARCH_ENABLED: 'false', GROQ_API_KEY: 'groq-secret', AI_PROVIDER_ORDER: 'groq' });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'provider backend text' } }] }) });
  try {
    const provider = response();
    await chat({ method: 'POST', headers: { 'x-forge-assist-secret': 'secret' }, body: { message: 'Are you ChatGPT?' } }, provider);
    assert.equal(provider.statusCode, 200);
    assert.match(provider.body.response, /Forge Assist/);
    assert.match(provider.body.response, /groq/);
    assert.doesNotMatch(provider.body.response, /I am ChatGPT|I am OpenAI/i);
  } finally { global.fetch = originalFetch; process.env = previous; }
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

