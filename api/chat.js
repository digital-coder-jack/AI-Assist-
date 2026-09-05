const { generateAnswer, systemPrompt } = require('../src/backend/providers');
const { prepareRequest } = require('../src/backend/retrieval');

function authorized(req) {
  const expected = process.env.FORGE_ASSIST_API_SECRET;
  return !expected || req.headers['x-forge-assist-secret'] === expected;
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
    const result = await generateAnswer({ prompt: prepared.prompt, context: prepared.context, system: systemPrompt(), env: process.env });
    return res.status(200).json({ response: result.text, provider: result.provider, sources: prepared.web.results.map(result => ({ title: result.title, url: result.url })), route: prepared.route.source, language: prepared.language.language });
  } catch (error) {
    console.error(`[forge-assist] chat failed: ${error.message}`);
    return res.status(503).json({ error: 'ai_unavailable', message: 'Forge Assist is temporarily unavailable. Please try again shortly.' });
  }
};
