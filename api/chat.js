const { generateAnswer, systemPrompt } = require('../src/backend/providers');
const { prepareRequest, detectLanguageStyle, identityIntent, identityResponse } = require('../src/backend/retrieval');

function authorized(req) {
  const expected = process.env.FORGE_ASSIST_API_SECRET;
  return !expected || req.headers['x-forge-assist-secret'] === expected;
}

function configuredProvider(env = process.env) {
  const order = (env.AI_PROVIDER_ORDER || 'claude,kimi,groq').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return order.find(name => ({ claude: env.CLAUDE_API_KEY, kimi: env.KIMI_API_KEY, groq: env.GROQ_API_KEY }[name])) || '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const prompt = typeof body.message === 'string' ? body.message.trim() : '';
  const context = Array.isArray(body.context) ? body.context.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-20) : [];
  if (!prompt || prompt.length > 8000) return res.status(400).json({ error: 'message_required', message: 'Please provide a message up to 8000 characters.' });
  try {
    const prepared = await prepareRequest({ prompt, context, community: body.community || {}, env: process.env });
    const language = detectLanguageStyle(prompt).language;
    const intent = identityIntent(prompt);
    if (intent === 'introduction' || intent === 'creator') {
      return res.status(200).json({ response: identityResponse(intent, language), provider: 'identity', sources: [], route: 'GENERAL KNOWLEDGE', language });
    }
    const result = await generateAnswer({ prompt: prepared.prompt, context: prepared.context, system: systemPrompt(), env: process.env });
    const responseText = intent === 'provider' ? identityResponse(intent, language, result.provider) : result.text;
    return res.status(200).json({ response: responseText, provider: result.provider, sources: prepared.web.results.map(item => ({ title: item.title, url: item.url })), route: prepared.route.source, language });
  } catch (error) {
    console.error(`[forge-assist] chat failed: ${error.message}`);
    return res.status(503).json({ error: 'ai_unavailable', message: 'Forge Assist is temporarily unavailable. Please try again shortly.' });
  }
};

module.exports._test = { configuredProvider };
