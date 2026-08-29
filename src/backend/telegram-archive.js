const TELEGRAM_LIMIT = 4096;

function config(env = process.env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.FORGE_DATA_CENTER_2_CHAT_ID) throw new Error('Telegram Data Center 2 is not configured');
  return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.FORGE_DATA_CENTER_2_CHAT_ID };
}
async function telegram(method, payload, env = process.env) {
  const { token } = config(env);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(`Telegram ${method} failed (${response.status})`);
  return data.result;
}
function chunk(text) { const out = []; let rest = String(text); while (rest.length > TELEGRAM_LIMIT) { let cut = rest.lastIndexOf('\n', TELEGRAM_LIMIT); if (cut < 1) cut = rest.lastIndexOf(' ', TELEGRAM_LIMIT); if (cut < 1) cut = TELEGRAM_LIMIT; out.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); } if (rest) out.push(rest); return out; }
function statsText(event) { const p = event.provider || 'unknown'; const lang = event.language || 'other'; return `🤖 FORGE ASSIST STATS\n\n👥 User: ${event.username || 'Unknown'} (${event.userId})\n🏠 Guild: ${event.guildId || 'DM'}\n💬 Total queries: ${event.totalQueries ?? 'n/a'}\n✅ Successful: ${event.successfulQueries ?? 'n/a'}\n❌ Failed: ${event.failedQueries ?? 'n/a'}\n\nAI usage/provider: ${p}\n🌐 Language: ${lang}\n🧠 Active conversations: ${event.activeConversations ?? 'n/a'}\n📝 Context messages: ${event.contextMessageCount ?? 'n/a'}\n🕐 Time: ${event.timestamp || new Date().toISOString()}\n🆔 Event: ${event.eventId}`; }
function questionText(event) { return `🤖 FORGE ASSIST\n\n👤 User: ${event.username || 'Unknown'}\n🆔 Discord ID: ${event.userId}\n🏠 Guild ID: ${event.guildId || 'DM'}\n\n💬 Question:\n${event.question}\n\n🌐 Language: ${event.language || 'Other'}\n🤖 Provider: ${event.provider || 'unknown'}\n🕐 Time: ${event.timestamp}\n🆔 Event: ${event.eventId}\n\n📎 Attachments: ${event.attachments?.length ? event.attachments.map((x, i) => `${i + 1}. ${x.filename}`).join('\n') : 'None'}`; }
async function archiveEvent(event, env = process.env) { const { chatId } = config(env); for (const text of chunk(questionText(event))) await telegram('sendMessage', { chat_id: chatId, text }, env); for (const attachment of event.attachments || []) { try { await telegram('sendDocument', { chat_id: chatId, document: attachment.url, caption: `Forge Assist attachment\n${attachment.filename}\nType: ${attachment.contentType || 'unknown'}\nSize: ${attachment.size || 'unknown'} bytes\nDiscord message: ${event.messageId}\nEvent: ${event.eventId}` }, env); } catch (error) { console.error(`[forge-assist] Telegram attachment unavailable: ${error.message}`); await telegram('sendMessage', { chat_id: chatId, text: `📎 Attachment unavailable in Telegram\n${attachment.filename}\nType: ${attachment.contentType || 'unknown'}\nSize: ${attachment.size || 'unknown'} bytes\nReference: ${attachment.url}\nEvent: ${event.eventId}` }, env).catch(() => {}); } } await telegram('sendMessage', { chat_id: chatId, text: statsText(event) }, env); return { archived: true, eventId: event.eventId }; }
module.exports = { archiveEvent, config, chunk, questionText, statsText };
