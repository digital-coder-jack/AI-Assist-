const DEFAULT_TIMEOUT_MS = 20000;

class ProviderError extends Error {
  constructor(provider, message, status) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function requestJson(url, options, timeoutMs) {
  const timer = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: timer.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error?.message || body.message || 'provider request failed'}`);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms`);
    throw error;
  } finally { timer.clear(); }
}

function messagesFor(prompt, context = []) {
  return [...context, { role: 'user', content: prompt }];
}

function openAiCompatible(name, baseUrl, apiKey, model, prompt, context, timeoutMs) {
  return requestJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: messagesFor(prompt, context), temperature: 0.5 })
  }, timeoutMs).then(body => {
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('malformed provider response');
    return content.trim();
  }).catch(error => { throw new ProviderError(name, error.message); });
}

function claude(apiKey, model, prompt, context, timeoutMs) {
  return requestJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1200, system: systemPrompt(), messages: messagesFor(prompt, context) })
  }, timeoutMs).then(body => {
    const content = body.content?.find(item => item.type === 'text')?.text;
    if (typeof content !== 'string' || !content.trim()) throw new Error('malformed provider response');
    return content.trim();
  }).catch(error => { throw new ProviderError('claude', error.message); });
}

function systemPrompt() {
  return 'You are Forge Assist, a friendly Discord technical assistant. Respond in the same language and conversational style used by the user. Preserve English, Hindi, Hinglish, Spanish, French, German, and other languages when detectable. If the user mixes languages, follow the dominant conversational language and preserve the natural mix. Do not translate or change the user\'s language unless explicitly requested. Be concise for simple questions and practical for technical questions, using code blocks when useful. Do not claim to be human. Refuse requests that enable credential theft, destructive malware, unauthorized access, or real-world harm, and redirect to safe defensive learning.';
}

function configuredProviders(env = process.env) {
  const timeoutMs = Number(env.AI_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const definitions = {
    claude: env.CLAUDE_API_KEY ? () => claude(env.CLAUDE_API_KEY, env.CLAUDE_MODEL || 'claude-3-5-haiku-latest', '', [], timeoutMs) : null,
    kimi: env.KIMI_API_KEY ? () => openAiCompatible('kimi', env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', env.KIMI_API_KEY, env.KIMI_MODEL || 'moonshot-v1-8k', '', [], timeoutMs) : null,
    groq: env.GROQ_API_KEY ? () => openAiCompatible('groq', env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.1-8b-instant', '', [], timeoutMs) : null
  };
  return definitions;
}

async function generateAnswer({ prompt, context = [], env = process.env, logger = console }) {
  const timeoutMs = Number(env.AI_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const definitions = {
    claude: env.CLAUDE_API_KEY ? () => claude(env.CLAUDE_API_KEY, env.CLAUDE_MODEL || 'claude-3-5-haiku-latest', prompt, context, timeoutMs) : null,
    kimi: env.KIMI_API_KEY ? () => openAiCompatible('kimi', env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', env.KIMI_API_KEY, env.KIMI_MODEL || 'moonshot-v1-8k', prompt, context, timeoutMs) : null,
    groq: env.GROQ_API_KEY ? () => openAiCompatible('groq', env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.1-8b-instant', prompt, context, timeoutMs) : null
  };
  const order = (env.AI_PROVIDER_ORDER || 'claude,kimi,groq').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const failures = [];
  for (const name of order) {
    if (!definitions[name]) continue;
    try { return { text: await definitions[name](), provider: name, failures }; }
    catch (error) { failures.push({ provider: name, message: error.message }); logger.error?.(`[forge-assist] provider ${name} failed: ${error.message}`); }
  }
  throw new Error(failures.length ? 'All configured AI providers are unavailable' : 'No AI providers are configured');
}

module.exports = { generateAnswer, ProviderError, systemPrompt, configuredProviders };
