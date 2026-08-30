const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanValue, readDiscordToken, readConfiguredChannelIds, logTokenDiagnostic, logChannelDiagnostic } = require('../src/bot/config');
const { startBot } = require('../src/bot');

test('Discord token values are normalized without changing the actual secret', () => {
  assert.equal(cleanValue('  "token-value"  '), 'token-value');
  assert.equal(readDiscordToken({ DISCORD_TOKEN: '  token-value  ' }), 'token-value');
  assert.equal(readDiscordToken({}), null);
});

test('startup diagnostic exposes only presence and length', () => {
  const lines = []; logTokenDiagnostic('secret-token', { log: value => lines.push(value) });
  assert.equal(lines[0], '[forge-assist] DISCORD_TOKEN configured: true (length: 12)');
  assert.equal(lines.join('\n').includes('secret-token'), false);
});

test('channel IDs are normalized from whitespace, commas, and surrounding quotes', () => {
  assert.deepEqual(readConfiguredChannelIds({ FORGE_ASSIST_CHANNEL_IDS: ' "1543290283960172604" , 123456789 ' }), ['1543290283960172604', '123456789']);
});

test('channel diagnostic exposes only configuration state and parsed IDs', () => {
  const lines = [];
  logChannelDiagnostic(['1543290283960172604'], { log: value => lines.push(value) });
  assert.deepEqual(lines, ['[forge-assist] FORGE_ASSIST_CHANNEL_IDS configured: true (parsed: 1543290283960172604)']);
});

test('startup reaches the Discord login stage with the normalized token', async () => {
  let received; const logger = { log() {} };
  await startBot({ env: { DISCORD_TOKEN: ' "configured-token" ' }, botFactory: () => ({ login: async token => { received = token; return 'login-called'; } }), logger });
  assert.equal(received, 'configured-token');
});
