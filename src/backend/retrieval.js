const DEFAULT_SEARCH_TIMEOUT_MS = 6000;
const MAX_RESULTS = 5;

function normalizeText(value, max = 1000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function detectLanguageStyle(text = '') {
  const value = String(text);
  const lower = value.toLowerCase();
  const hasDevanagari = /[\u0900-\u097f]/.test(value);
  const romanHindi = /\b(bhai|bhaiya|hai|hain|kya|kaise|kyu|kyon|kar|karo|mujhe|mujh|bata|batao|samjha|samjhao|ye|woh|iska|uska|ke|mein|me|se|ko|aur|nahi|haan|achha|accha|chahiye|jaankari|baare|bare)\b/.test(lower);
  const english = /\b(the|what|why|how|when|where|who|latest|current|please|explain|help|about|update|search|find|today|news|pricing|code|error|use|using)\b/.test(lower);
  let language = 'Other';
  if (hasDevanagari && english) language = 'Mixed Hindi-English';
  else if (hasDevanagari) language = 'Hindi';
  else if (romanHindi && english) language = 'Hinglish';
  else if (romanHindi) language = 'Hinglish';
  else if (english) language = 'English';
  return { language, style: hasDevanagari ? 'Hindi script' : romanHindi ? 'Roman-script conversational' : 'natural user style' };
}

function sanitizeCommunity(input = {}) {
  const guild = input.guild && typeof input.guild === 'object' ? input.guild : {};
  const channel = input.channel && typeof input.channel === 'object' ? input.channel : {};
  const roles = Array.isArray(input.publicRoles) ? input.publicRoles.map(role => normalizeText(role, 80)).filter(Boolean).slice(0, 30) : [];
  return {
    guild: { id: normalizeText(guild.id, 100), name: normalizeText(guild.name, 160), description: normalizeText(guild.description, 500) },
    channel: { id: normalizeText(channel.id, 100), name: normalizeText(channel.name, 100), topic: normalizeText(channel.topic, 500) },
    publicRoles: roles,
    rules: Array.isArray(input.rules) ? input.rules.map(rule => normalizeText(rule, 300)).filter(Boolean).slice(0, 20) : [],
  };
}

function hasCommunityData(community = {}) {
  return Boolean(community.guild?.name || community.guild?.description || community.channel?.name || community.channel?.topic || community.publicRoles?.length || community.rules?.length);
}
function communityRequested(prompt, community) {
  const lower = String(prompt).toLowerCase();
  const guildName = String(community?.guild?.name || '').toLowerCase();
  return /\b(community|server|guild|discord|channel|channels|role|roles|member|members|developer forge|forge)\b/.test(lower) || Boolean(guildName && lower.includes(guildName));
}
function webRequested(prompt) {
  const lower = String(prompt).toLowerCase();
  return /\b(latest|current|today|tonight|recent|news|now|updated|update|pricing|price|version|release|who is the current|search online|search the web|look online|look up|find online|on the internet|public info)\b/.test(lower) || /\b(aaj|abhi|haal hi|naya|nayi)\b/.test(lower);
}
function routeQuestion(prompt, community = {}) {
  const communityNeeded = communityRequested(prompt, community);
  const webNeeded = webRequested(prompt);
  return { communityNeeded, webNeeded, source: communityNeeded && webNeeded ? 'COMMUNITY + WEB' : communityNeeded ? 'COMMUNITY' : webNeeded ? 'WEB' : 'GENERAL KNOWLEDGE' };
}

async function searchWeb(query, { env = process.env, fetchImpl = fetch } = {}) {
  if (String(env.WEB_SEARCH_ENABLED).toLowerCase() !== 'true') return { enabled: false, results: [], reason: 'disabled', provider: 'tavily' };
  if (!env.TAVILY_API_KEY) return { enabled: false, results: [], reason: 'api_key_missing', provider: 'tavily' };
  const timeoutMs = Number(env.WEB_SEARCH_TIMEOUT_MS || DEFAULT_SEARCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.tavily.com/search', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` }, body: JSON.stringify({ query: normalizeText(query, 1200), search_depth: 'basic', max_results: MAX_RESULTS, include_answer: false, include_raw_content: false, topic: /\b(news|today|aaj|recent|latest)\b/i.test(query) ? 'news' : 'general' }), signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`search provider returned ${response.status}`);
    const results = (body.results || []).slice(0, MAX_RESULTS).map(item => ({ title: normalizeText(item.title, 180), url: normalizeText(item.url, 500), description: normalizeText(item.content || item.raw_content || item.description, 700), score: Number.isFinite(Number(item.score)) ? Number(item.score) : null, publishedDate: normalizeText(item.published_date, 80) })).filter(item => item.title && item.description && /^https?:\/\//.test(item.url)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { enabled: true, results, reason: results.length ? 'ok' : 'empty', provider: 'tavily' };
  } catch (error) {
    return { enabled: true, results: [], reason: error.name === 'AbortError' ? 'timeout' : 'failed', provider: 'tavily' };
  } finally { clearTimeout(timer); }
}

function formatCommunity(community) {
  if (!hasCommunityData(community)) return 'No explicit community information is available.';
  const lines = [];
  if (community.guild.name) lines.push(`Guild/server: ${community.guild.name}`);
  if (community.guild.description) lines.push(`Guild description: ${community.guild.description}`);
  if (community.channel.name) lines.push(`Current channel: #${community.channel.name}`);
  if (community.channel.topic) lines.push(`Channel topic: ${community.channel.topic}`);
  if (community.publicRoles.length) lines.push(`Public role names (not personal attributes): ${community.publicRoles.join(', ')}`);
  if (community.rules.length) lines.push(`Explicit rules/instructions: ${community.rules.join(' | ')}`);
  return lines.join('\n');
}
function formatWeb(results) {
  if (!results.length) return 'No reliable web results were available.';
  return results.map((item, index) => `[${index + 1}] ${item.title}\nURL: ${item.url}\nSnippet: ${item.description}${item.publishedDate ? `\nDate: ${item.publishedDate}` : ''}`).join('\n\n');
}
function identityIntent(prompt = '') {
  const lower = String(prompt).toLowerCase().trim();
  if (/\b(who are you|what are you|what is forge assist|introduce yourself|tell me about yourself|what do you do|why are you here)\b/.test(lower) || /\b(apne baare (mein|main|mai|me)|apne bare (mein|main|mai|me))\b/.test(lower) || /अपने बारे में/.test(lower)) return 'introduction';
  if (/\b(who made you|who created you|who built you|who is behind you)\b/.test(lower)) return 'creator';
  if (/\b(are you openai|are you chatgpt|are you claude|are you groq|are you kimi|which model|which api|what provider|what ai service)\b/.test(lower)) return 'provider';
  return null;
}
function identityResponse(intent, language, provider = '') {
  const hinglish = language === 'Hinglish' || language === 'Mixed Hindi-English';
  if (intent === 'introduction') return hinglish ? 'Main Forge Assist hoon — Developer Forge community ka AI assistant. Main members ke questions, coding, technology aur community-related cheezon mein help karta hoon. Mujhe Jack ne build/configure kiya hai, jo Developer Forge ke community admin hain.' : language === 'Hindi' ? 'मैं Forge Assist हूँ — Developer Forge community का AI assistant। मैं members के सवालों, coding, technology और community-related topics में मदद करता हूँ। मुझे Jack ने build/configure किया है, जो Developer Forge के community admin हैं।' : "I'm Forge Assist, the AI assistant for the Developer Forge community. I'm here to help members with coding, technology, questions, and community-related topics. Jack, the Developer Forge community admin, built and configured me.";
  if (intent === 'creator') return hinglish ? 'Mujhe Jack ne build/configure kiya hai — woh Developer Forge community admin hain. Unhone underlying AI model train nahi kiya.' : language === 'Hindi' ? 'मुझे Jack ने build/configure किया है — वे Developer Forge community admin हैं। उन्होंने underlying AI model train नहीं किया है।' : 'Jack, the Developer Forge community admin, built and configured me. He did not train the underlying AI model.';
  const providerName = provider || 'different AI services';
  return hinglish ? `Main Forge Assist hoon, Developer Forge community ka AI assistant. Main behind the scenes ${providerName} use kar sakta hoon; ye implementation detail hai, meri identity nahi.` : language === 'Hindi' ? `मैं Forge Assist हूँ, Developer Forge community का AI assistant। मैं behind the scenes ${providerName} use कर सकता हूँ; यह implementation detail है, मेरी identity नहीं।` : `I'm Forge Assist, the AI assistant for the Developer Forge community. For this request, the configured provider is ${providerName}; that is an implementation detail, not my identity.`;
}
function formatMemory(memory = {}) {
  if (memory.status === 'ambiguous') return 'Several prior contexts may match. Ask one short clarification question rather than guessing.';
  if (!Array.isArray(memory.items) || !memory.items.length) return 'No relevant long-term member memory was found. Do not pretend to remember unrelated context.';
  return memory.items.slice(0, 4).map((item, index) => `[${index + 1}] ${normalizeText(item.text, 280)}`).join('\n');
}
function buildGrounding({ prompt, context = [], community = {}, web = {}, memory = { status: 'none', items: [] } }) {
  const language = detectLanguageStyle(prompt);
  const route = routeQuestion(prompt, community);
  const sections = [
    `Answer source route: ${route.source}.`,
    `Language/style requirement: respond in ${language.language} using the user's ${language.style}. Do not translate Roman Hindi/Hinglish into formal Hindi.`,
    'Community-data rule: use only the explicit community information below. Never infer sensitive or personal attributes from roles, names, or missing data.',
    `Explicit community information:\n${formatCommunity(community)}`,
    `Member-memory rule: use only the explicit, relevant, user-scoped memory below. Do not reveal storage, metadata, Telegram, or internal records. Mention prior context only when it naturally helps. If confidence is low, use cautious wording such as “agar tu usi project ki baat kar raha hai...” rather than pretending to remember.\nRelevant member memory:\n${formatMemory(memory)}`,
  ];
  if (web.results?.length || route.webNeeded) sections.push(`Web-data rule: if web data is present, distinguish it from community data and cite concise source URLs. Do not invent current facts.\nWeb search results:\n${formatWeb(web.results || [])}`);
  if (context.length) sections.push(`Conversation context is user-provided history and may be incomplete:\n${context.slice(-12).map(item => `${item.role}: ${normalizeText(item.content, 1000)}`).join('\n')}`);
  sections.push(`User question:\n${normalizeText(prompt, 8000)}`);
  return sections.join('\n\n');
}
async function prepareRequest({ prompt, context = [], community = {}, memory = { status: 'none', items: [] }, env = process.env, fetchImpl = fetch }) {
  const safeCommunity = sanitizeCommunity(community);
  const safeMemory = { status: memory.status === 'ambiguous' ? 'ambiguous' : 'resolved', items: Array.isArray(memory.items) ? memory.items.filter(item => item && typeof item.text === 'string').slice(0, 4) : [] };
  const route = routeQuestion(prompt, safeCommunity);
  const web = route.webNeeded ? await searchWeb(prompt, { env, fetchImpl }) : { enabled: false, results: [], reason: 'not_needed' };
  return { prompt: buildGrounding({ prompt, context, community: safeCommunity, memory: safeMemory, web }), context: [], community: safeCommunity, memory: safeMemory, web, route, language: detectLanguageStyle(prompt) };
}

module.exports = { normalizeText, detectLanguageStyle, sanitizeCommunity, hasCommunityData, communityRequested, webRequested, routeQuestion, searchWeb, formatCommunity, formatWeb, formatMemory, identityIntent, identityResponse, buildGrounding, prepareRequest };
