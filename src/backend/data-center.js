const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const EMPTY = { users: {}, questions: [], attachments: [], totals: { queries: 0, successful: 0, failed: 0, providers: {}, languages: {} } };

function createS3Store(env = process.env) {
  const bucket = env.FORGE_ASSIST_S3_BUCKET;
  if (!bucket || !env.FORGE_ASSIST_S3_ENDPOINT || !env.FORGE_ASSIST_S3_ACCESS_KEY || !env.FORGE_ASSIST_S3_SECRET_KEY) throw new Error('Forge Assist S3 storage is not configured');
  const client = new S3Client({ region: env.FORGE_ASSIST_S3_REGION || 'auto', endpoint: env.FORGE_ASSIST_S3_ENDPOINT, forcePathStyle: env.FORGE_ASSIST_S3_FORCE_PATH_STYLE !== 'false', credentials: { accessKeyId: env.FORGE_ASSIST_S3_ACCESS_KEY, secretAccessKey: env.FORGE_ASSIST_S3_SECRET_KEY } });
  return {
    async read() { try { const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: env.FORGE_ASSIST_S3_DATA_KEY || 'forge-assist/data.json' })); return JSON.parse(await result.Body.transformToString()); } catch (error) { if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return structuredClone(EMPTY); throw error; } },
    async write(data) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: env.FORGE_ASSIST_S3_DATA_KEY || 'forge-assist/data.json', Body: JSON.stringify(data), ContentType: 'application/json' })); },
    async putAttachment(key, body, contentType) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType || 'application/octet-stream' })); return `${env.FORGE_ASSIST_S3_PUBLIC_BASE_URL || `${env.FORGE_ASSIST_S3_ENDPOINT}/${bucket}`}/${key}`; }
  };
}
function createMemoryStore(seed) { let data = structuredClone(seed || EMPTY); const files = new Map(); return { async read() { return structuredClone(data); }, async write(next) { data = structuredClone(next); }, async putAttachment(key, body, contentType) { files.set(key, { body, contentType }); return `memory://${key}`; }, _files: files }; }
function languageOf(text = '') { const lower = text.toLowerCase(); const hindi = /[\u0900-\u097f]/.test(text); if (hindi) return 'hindi'; const hinglish = /\b(bhai|hai|kya|kaise|kyu|kar|ye|mujhe|samjha|bata)\b/.test(lower); if (hinglish) return 'hinglish'; if (/\b(the|what|why|how|please|explain|error|code)\b/.test(lower)) return 'english'; return 'other'; }
async function recordEvent(store, event) {
  const data = await store.read(); const userKey = `${event.guildId || 'dm'}:${event.userId}`; const now = event.timestamp || new Date().toISOString();
  const user = data.users[userKey] || { guildId: event.guildId || null, userId: event.userId, username: event.username || 'Unknown', firstSeen: now, lastSeen: now, totalQueries: 0, successfulQueries: 0, failedQueries: 0, providers: {}, languages: {}, activeConversations: 0, contextMessageCount: 0, attachmentCount: 0 };
  user.username = event.username || user.username; user.lastSeen = now; user.totalQueries += 1; user[event.success ? 'successfulQueries' : 'failedQueries'] += 1; const provider = event.provider || 'unknown'; user.providers[provider] = user.providers[provider] || { success: 0, failure: 0 }; user.providers[provider][event.success ? 'success' : 'failure'] += 1; const language = event.language || languageOf(event.question); user.languages[language] = (user.languages[language] || 0) + 1; user.activeConversations = event.activeConversations ?? user.activeConversations; user.contextMessageCount = event.contextMessageCount ?? user.contextMessageCount; data.users[userKey] = user;
  data.totals.queries += 1; data.totals[event.success ? 'successful' : 'failed'] += 1; data.totals.providers[provider] = data.totals.providers[provider] || { success: 0, failure: 0 }; data.totals.providers[provider][event.success ? 'success' : 'failure'] += 1; data.totals.languages[language] = (data.totals.languages[language] || 0) + 1;
  if (event.question) data.questions.unshift({ id: event.messageId || `${Date.now()}-${Math.random()}`, guildId: event.guildId || null, userId: event.userId, username: event.username, question: event.question.slice(0, 8000), timestamp: now, attachmentIds: event.attachmentIds || [] });
  await store.write(data); return user;
}
async function recordAttachment(store, item) { const data = await store.read(); const key = item.storageKey || `forge-assist/attachments/${item.messageId}-${item.filename}`; const reference = await store.putAttachment(key, item.body, item.contentType); const record = { filename: item.filename, contentType: item.contentType, size: item.size, timestamp: item.timestamp || new Date().toISOString(), messageId: item.messageId, userId: item.userId, storageReference: reference, storageKey: key }; data.attachments.unshift(record); const user = Object.values(data.users).find(x => x.userId === item.userId && x.guildId === (item.guildId || null)); if (user) user.attachmentCount += 1; await store.write(data); return record; }
module.exports = { EMPTY, createS3Store, createMemoryStore, recordEvent, recordAttachment, languageOf };
