const assert = require('node:assert/strict');

Object.assign(process.env, {
  JWT_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'test-only-server-key',
  CORS_ORIGIN: 'http://localhost:3000',
  INITIAL_ADMIN_USERNAME: 'ADMIN',
  INITIAL_ADMIN_PASSWORD: 'test-password',
  NODE_ENV: 'development',
  STATE_JSON_LIMIT_KB: '512'
});

const app = require('../server/app');

async function run() {
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    let response = await fetch(`${baseUrl}/api/not-real`);
    assert.equal(response.status, 404, 'unknown API routes must return 404 without database work');

    response = await fetch(`${baseUrl}/api/state`);
    assert.equal(response.status, 401, 'state reads must require authentication');

    response = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415, 'state writes must require JSON');

    response = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(513 * 1024) }) });
    assert.equal(response.status, 413, 'oversized state writes must be rejected before authentication or parsing');

    response = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401, 'normal-sized state writes must authenticate before JSON parsing');

    response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400, 'malformed JSON must return 400');

    response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(9 * 1024) }) });
    assert.equal(response.status, 413, 'oversized login bodies must return 413');

    response = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
    assert.equal(response.status, 200, 'logout must remain available');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('Pemeriksaan HTTP keamanan berhasil.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
