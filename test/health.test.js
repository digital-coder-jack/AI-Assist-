const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../api/health');

test('Vercel health handler returns backend status', async () => {
  let statusCode; let payload;
  const response = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return value; } };
  await health({ method: 'GET' }, response);
  assert.equal(statusCode, 200);
  assert.deepEqual(payload, { status: 'ok', service: 'forge-assist-backend' });
});

test('Vercel health handler rejects unsupported methods', async () => {
  let statusCode;
  const response = { status(code) { statusCode = code; return this; }, json() {} };
  await health({ method: 'POST' }, response);
  assert.equal(statusCode, 405);
});
