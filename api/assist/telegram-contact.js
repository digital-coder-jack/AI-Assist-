const { handleWebhook } = require('../../src/backend/telegram-contact');

function webhookAuthorized(req) {
  const expected = process.env.TELEGRAM_CONTACT_WEBHOOK_SECRET || process.env.FORGE_ASSIST_API_SECRET;
  return !expected || req.headers['x-telegram-bot-api-secret-token'] === expected;
}
async function deliverDiscord(payload, text, metadata = {}) {
  if (!process.env.DISCORD_TOKEN) throw new Error('Discord delivery is not configured');
  const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(payload.discordChannelId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, allowed_mentions: { parse: [] }, message_reference: payload.discordMessageId ? { message_id: payload.discordMessageId, fail_if_not_exists: false } : undefined }),
  });
  if (!response.ok) throw new Error(`Discord delivery failed (${response.status})`);
  return response.json().catch(() => ({}));
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!webhookAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await handleWebhook(req.body || {}, process.env, deliverDiscord);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error(`[forge-assist] contact webhook failed: ${error.message}`);
    return res.status(200).json({ ok: false, error: 'contact_webhook_failed' });
  }
};
module.exports._test = { webhookAuthorized, deliverDiscord };
