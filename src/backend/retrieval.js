const DEFAULT_SEARCH_TIMEOUT_MS = 5000;
const MAX_RESULTS = 4;

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
  if (String(env.WEB_SEARCH_ENABLED).toLowerCase() !== 'true') return { enabled: false, results: [], reason: 'disabled' };
  if (!env.BRAVE_SEARCH_API_KEY) return { enabled: false, results: [], reason: 'api_key_missing' };
  const timeoutMs = Number(env.WEB_SEARCH_TIMEOUT_MS || DEFAULT_SEARCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', normalizeText(query, 400));
    url.searchParams.set('count', String(MAX_RESULTS));
    url.searchParams.set('safesearch', 'moderate');
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'x-subscription-token': env.BRAVE_SEARCH_API_KEY }, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`search provider returned ${response.status}`);
    const results = (body.web?.results || []).slice(0, MAX_RESULTS).map(item => ({ title: normalizeText(item.title, 180), url: normalizeText(item.url, 500), description: normalizeText(item.description, 600), age: normalizeText(item.age, 80) })).filter(item => item.title && /^https?:\/\//.test(item.url));
    return { enabled: true, results, reason: results.length ? 'ok' : 'empty' };
  } catch (error) {
    return { enabled: true, results: [], reason: error.name === 'AbortError' ? 'timeout' : 'failed' };
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
  return results.map((item, index) => `[${index + 1}] ${item.title}\nURL: ${item.url}\nSnippet: ${item.description}${item.age ? `\nDate: ${item.age}` : ''}`).join('\n\n');
}
function buildGrounding({ prompt, context = [], community = {}, web = {} }) {
  const language = detectLanguageStyle(prompt);
  const route = routeQuestion(prompt, community);
  const sections = [
    `Answer source route: ${route.source}.`,
    `Language/style requirement: respond in ${language.language} using the user's ${language.style}. Do not translate Roman Hindi/Hinglish into formal Hindi.`,
    'Community-data rule: use only the explicit community information below. Never infer sensitive or personal attributes from roles, names, or missing data.',
    `Explicit community information:\n${formatCommunity(community)}`,
  ];
  if (web.results?.length || route.webNeeded) sections.push(`Web-data rule: if web data is present, distinguish it from community data and cite concise source URLs. Do not invent current facts.\nWeb search results:\n${formatWeb(web.results || [])}`);
  if (context.length) sections.push(`Conversation context is user-provided history and may be incomplete:\n${context.slice(-12).map(item => `${item.role}: ${normalizeText(item.content, 1000)}`).join('\n')}`);
  sections.push(`User question:\n${normalizeText(prompt, 8000)}`);
  return sections.join('\n\n');
}
async function prepareRequest({ prompt, context = [], community = {}, env = process.env, fetchImpl = fetch }) {
  const safeCommunity = sanitizeCommunity(community);
  const route = routeQuestion(prompt, safeCommunity);
  const web = route.webNeeded ? await searchWeb(prompt, { env, fetchImpl }) : { enabled: false, results: [], reason: 'not_needed' };
  return { prompt: buildGrounding({ prompt, context, community: safeCommunity, web }), context: [], community: safeCommunity, web, route, language: detectLanguageStyle(prompt) };
}

module.exports = { normalizeText, detectLanguageStyle, sanitizeCommunity, hasCommunityData, communityRequested, webRequested, routeQuestion, searchWeb, formatCommunity, formatWeb, buildGrounding, prepareRequest };
