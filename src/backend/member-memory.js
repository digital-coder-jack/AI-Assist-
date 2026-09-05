const crypto = require('node:crypto');

const MAX_ITEMS_PER_MEMBER = 24;
const MAX_MEMORY_LENGTH = 280;
const memoryByUser = new Map();
const STOP_WORDS = new Set('a an the and or but hai hain ho ka ke ki ko mein me mai main par pe se to tu tum aap apne apni this that with for from about into kya ye woh jo us it is are was were been being i am im my mujhe mera meri humne hum you your we our bhai bro please'.split(' '));
const SENSITIVE = /(?:password|passcode|otp|token|api[_ -]?key|secret|credential|private key|authorization|bearer\s+|cookie|session id|access key|refresh token)/i;
const FORGET = /\b(forget|remove|delete|clear|bhool jao|bhul jao|yaad mat rakhna|yaad na rakhna)\b/i;
const FORGET_ALL = /\b(everything|all|all memories|sab kuch)\b/i;
const FOLLOW_UP = /\b(wahi|phir se|previous|pehle|kal|same|again|continue|us error|ab|remember|that project|mera previous)\b/i;

function clean(value, max = MAX_MEMORY_LENGTH) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function userKey(userId) { return String(userId || '').trim(); }
function memoryId(text) { return crypto.createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16); }
function tokenize(text) { return new Set(clean(text, 800).toLowerCase().split(/[^a-z0-9\u0900-\u097f]+/i).filter(token => token.length > 2 && !STOP_WORDS.has(token))); }
function topicsFor(text) {
  const value = text.toLowerCase();
  return ['javascript', 'python', 'discord', 'bot', 'vercel', 'webhook', 'deployment', 'deploy', 'react', 'node', 'api', 'error', 'project', 'coding', 'role', 'assign', 'assignment'].filter(topic => value.includes(topic));
}
function isForgetRequest(prompt) { return FORGET.test(String(prompt || '')); }
function explicitMemoryText(prompt) {
  const value = clean(prompt);
  if (!value || SENSITIVE.test(value)) return null;
  if (/\b(i('| a)?m|i am|main|mera|meri|my|we are|hum)\b.{0,80}\b(build|building|make|making|learn|learning|seekh|working|work|project|use|using|prefer|goal|trying|bana|bana raha|bana rahi|kar raha|kar rahi|deploy|deployment)\b/i.test(value)) return value;
  if (/\b(i|main|hum)\b.{0,80}\b(discord bot|javascript|python|vercel|webhook|react|node\.js|coding)\b/i.test(value)) return value;
  if (/\b(vercel|javascript|python|discord bot|webhook|react|node\.js)\b.{0,80}\b(deploy|deployment|seekh|learn|build|bana|project|work|use|using)\b/i.test(value) || /\b(error|issue|problem|not working|nahi ho raha|nahi chal|assign nahi|role.{0,30}assign|assign.{0,30}role|500|404)\b/i.test(value)) return value;
  return null;
}
function extractMemory(prompt, timestamp = new Date().toISOString()) {
  const text = clean(prompt, 8000);
  if (isForgetRequest(text)) return { action: 'forget', query: text, items: [] };
  const candidate = explicitMemoryText(text);
  if (!candidate) return { action: 'none', items: [] };
  return { action: 'upsert', items: [{ id: memoryId(candidate), text: candidate, topics: topicsFor(candidate), confidence: 'explicit', firstSeenAt: timestamp, lastSeenAt: timestamp }] };
}
function addMemory(userId, item) {
  const key = userKey(userId);
  if (!key || !item?.text || SENSITIVE.test(item.text)) return { stored: false, reason: 'unsafe_or_missing_user' };
  const list = memoryByUser.get(key) || [];
  const existing = list.find(memory => memory.id === item.id || memory.text.toLowerCase() === item.text.toLowerCase());
  if (existing) { existing.lastSeenAt = item.lastSeenAt || new Date().toISOString(); existing.hits = (existing.hits || 1) + 1; return { stored: true, updated: true, memory: existing }; }
  const memory = { ...item, hits: 1 };
  memoryByUser.set(key, [memory, ...list].slice(0, MAX_ITEMS_PER_MEMBER));
  return { stored: true, updated: false, memory };
}
function upsertFromPrompt(userId, prompt, timestamp) {
  const extracted = extractMemory(prompt, timestamp);
  if (extracted.action !== 'upsert') return extracted;
  return { ...extracted, results: extracted.items.map(item => addMemory(userId, item)) };
}
function forgetMemory(userId, prompt) {
  const key = userKey(userId);
  const list = memoryByUser.get(key) || [];
  const topics = topicsFor(prompt);
  const queryTokens = tokenize(prompt);
  const removeAll = FORGET_ALL.test(prompt) || (topics.length === 0 && queryTokens.size < 2);
  const remaining = removeAll ? [] : list.filter(memory => !(topics.some(topic => memory.topics.includes(topic)) || [...queryTokens].some(token => tokenize(memory.text).has(token))));
  memoryByUser.set(key, remaining);
  return { removed: list.length - remaining.length, remaining: remaining.length };
}
function relevance(memory, prompt) {
  const promptTokens = tokenize(prompt);
  const memoryTokens = tokenize(memory.text);
  const overlap = [...promptTokens].filter(token => memoryTokens.has(token)).length;
  const topicOverlap = topicsFor(prompt).filter(topic => memory.topics.includes(topic)).length;
  const followUpBoost = FOLLOW_UP.test(prompt) ? 0.2 : 0;
  return Math.min(1, overlap * 0.18 + topicOverlap * 0.25 + followUpBoost);
}
function retrieveMemory(userId, prompt, limit = 4) {
  const list = memoryByUser.get(userKey(userId)) || [];
  const genericReference = /\b(wahi|same|previous|that project|mera previous)\b/i.test(prompt);
  return list.map(memory => ({ ...memory, relevance: relevance(memory, prompt) })).filter(memory => genericReference ? memory.relevance >= 0.18 : memory.relevance >= 0.28 && (topicsFor(prompt).some(topic => memory.topics.includes(topic)) || [...tokenize(prompt)].some(token => tokenize(memory.text).has(token)))).sort((a, b) => b.relevance - a.relevance || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit);
}
function resolveMemory(userId, prompt, limit = 4) {
  const items = retrieveMemory(userId, prompt, limit);
  if (FOLLOW_UP.test(prompt) && items.length > 1 && Math.abs(items[0].relevance - items[1].relevance) < 0.2) return { status: 'ambiguous', items };
  return { status: items.length ? 'resolved' : 'none', items };
}
function memoryPrompt(memoryItems, prompt, status = 'resolved') {
  if (status === 'ambiguous') return 'Several possible prior contexts match this reference. Ask one short clarification question instead of guessing.';
  if (!memoryItems?.length) return 'No relevant long-term member memory was found. Do not pretend to remember unrelated context.';
  return memoryItems.map((memory, index) => `[${index + 1}] ${memory.text}`).join('\n');
}
function snapshot(userId) { return (memoryByUser.get(userKey(userId)) || []).map(item => ({ ...item })); }
function reset() { memoryByUser.clear(); }

module.exports = { MAX_ITEMS_PER_MEMBER, MAX_MEMORY_LENGTH, clean, isForgetRequest, explicitMemoryText, extractMemory, addMemory, upsertFromPrompt, forgetMemory, retrieveMemory, resolveMemory, memoryPrompt, snapshot, reset, _store: memoryByUser };
