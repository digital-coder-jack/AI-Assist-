let dotenvLoaded = false;
try {
  require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env', override: false, quiet: true });
  dotenvLoaded = true;
} catch (error) {
  // Wispbyte-provided environment variables do not require dotenv.
  console.warn(`[forge-assist] dotenv unavailable; using process environment (${error.code || error.message})`);
}

function cleanValue(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/^\uFEFF/, '').trim();
  if (cleaned.length >= 2 && ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))) return cleaned.slice(1, -1).trim();
  return cleaned;
}

function readDiscordToken(env = process.env) {
  return cleanValue(env.DISCORD_TOKEN) || null;
}

function readConfiguredChannelIds(env = process.env) {
  return cleanValue(env.FORGE_ASSIST_CHANNEL_IDS).split(',').map(value => cleanValue(value)).filter(Boolean);
}

function logTokenDiagnostic(token, logger = console) {
  logger.log(`[forge-assist] DISCORD_TOKEN configured: ${Boolean(token)} (length: ${token ? token.length : 0})`);
}

function logChannelDiagnostic(channelIds, logger = console) {
  logger.log(`[forge-assist] FORGE_ASSIST_CHANNEL_IDS configured: ${channelIds.length > 0} (parsed: ${channelIds.length ? channelIds.join(',') : 'none'})`);
}

module.exports = { cleanValue, readDiscordToken, readConfiguredChannelIds, logTokenDiagnostic, logChannelDiagnostic, dotenvLoaded };
