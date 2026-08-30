const test = require('node:test');
const assert = require('node:assert/strict');
const { logGuildDiagnostics } = require('../src/bot');

function fakeClient(guilds) { return { user: { tag: 'Forge Assist#8784', id: '123456789012345678' }, guilds: { cache: new Map(guilds.map(guild => [guild.id, guild])) } }; }

test('guild diagnostics reports identity and zero guilds safely', () => {
  const lines = []; logGuildDiagnostics(fakeClient([]), { log: value => lines.push(value) });
  assert.ok(lines.includes('[forge-assist] bot user ID: 123456789012345678'));
  assert.ok(lines.includes('[forge-assist] guild count: 0'));
  assert.ok(lines.includes('[forge-assist] serving 0 guilds'));
  assert.equal(lines.some(line => line.includes('token')), false);
});

test('guild diagnostics lists every connected guild and compares application ID', () => {
  const lines = []; logGuildDiagnostics(fakeClient([{ id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' }]), { log: value => lines.push(value) }, { DISCORD_APPLICATION_ID: '123456789012345678' });
  assert.ok(lines.includes('[forge-assist] configured application ID matches logged-in bot: true'));
  assert.ok(lines.includes('[forge-assist] guild count: 2'));
  assert.ok(lines.includes('[forge-assist] guild: Alpha (g1)'));
  assert.ok(lines.includes('[forge-assist] guild: Beta (g2)'));
});
