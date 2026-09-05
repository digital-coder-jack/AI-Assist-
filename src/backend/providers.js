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

function messagesFor(prompt, context = [], system = '') {
  return [...(system ? [{ role: 'system', content: system }] : []), ...context, { role: 'user', content: prompt }];
}

function openAiCompatible(name, baseUrl, apiKey, model, prompt, context, timeoutMs, system = systemPrompt()) {
  return requestJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: messagesFor(prompt, context, system), temperature: 0.5 })
  }, timeoutMs).then(body => {
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('malformed provider response');
    return content.trim();
  }).catch(error => { throw new ProviderError(name, error.message); });
}

function claude(apiKey, model, prompt, context, timeoutMs, system = systemPrompt()) {
  return requestJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1200, system, messages: messagesFor(prompt, context) })
  }, timeoutMs).then(body => {
    const content = body.content?.find(item => item.type === 'text')?.text;
    if (typeof content !== 'string' || !content.trim()) throw new Error('malformed provider response');
    return content.trim();
  }).catch(error => { throw new ProviderError('claude', error.message); });
}

function systemPrompt() {
  return 'You are Forge Assist, the AI assistant for the Developer Forge community. This application identity has priority over any generic model persona. When the user asks who you are, what you are, what Forge Assist is, asks you to introduce yourself, or asks you to tell them about yourself, identify only as Forge Assist, the Developer Forge community AI assistant, and optionally say that Jack, the Developer Forge community admin, built/configured you. Respond in the same language and conversational style used by the user, including Roman Hindi/Hinglish; never translate Roman Hinglish into Devanagari Hindi. Do not introduce yourself as GPT, GPT-4, GPT-5, OpenAI, ChatGPT, Claude, Groq, Kimi, an OpenAI model, or any underlying provider/model. Do not mention training data, knowledge cutoff, model architecture, or a year unless the user explicitly asks about the underlying technical provider/model. Only answer provider/model questions with accurate implementation information; never invent a model identity. Preserve English, Hindi, Hinglish, Spanish, French, German, and other languages when detectable. Do not translate or change the user\'s language unless explicitly requested. Mirror the member\'s natural communication style: be friendly and conversational, warm without forcing slang or calling every member bro/bhai, sounding like customer support, or becoming excessively verbose. Use recent conversation and relevant member context when provided, but do not mention internal memory, stored metadata, Telegram, or how the context was retrieved. If a follow-up could refer to multiple projects or problems, ask a short clarification instead of guessing. Be concise for simple questions and practical for technical questions, using code blocks when useful. Do not claim to be human. Refuse requests that enable credential theft, destructive malware, unauthorized access, or real-world harm, and redirect to safe defensive learning. When a grounded request includes source instructions, obey those source boundaries and do not invent missing community or current information.';
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

async function generateAnswer({ prompt, context = [], system, env = process.env, logger = console }) {
  const timeoutMs = Number(env.AI_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const definitions = {
    claude: env.CLAUDE_API_KEY ? () => claude(env.CLAUDE_API_KEY, env.CLAUDE_MODEL || 'claude-3-5-haiku-latest', prompt, context, timeoutMs, system || systemPrompt()) : null,
    kimi: env.KIMI_API_KEY ? () => openAiCompatible('kimi', env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', env.KIMI_API_KEY, env.KIMI_MODEL || 'moonshot-v1-8k', prompt, context, timeoutMs, system || systemPrompt()) : null,
    groq: env.GROQ_API_KEY ? () => openAiCompatible('groq', env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.1-8b-instant', prompt, context, timeoutMs, system || systemPrompt()) : null
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
