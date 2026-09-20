const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// Separate processes ensure the module-level payload limit is tested at startup.
if (!process.env.NETLIFY_LIMIT_TEST) {
  for (const limit of ['', '1536', '2048', '2049']) {
    execFileSync(process.execPath, [__filename], {
      env: { ...process.env, NETLIFY_LIMIT_TEST: '1', STATE_JSON_LIMIT_KB: limit },
      stdio: 'inherit'
    });
  }
} else {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}

async function run() {
  Object.assign(process.env, {
    JWT_SECRET: 'test-only-secret-that-is-at-least-32-characters',
    SUPABASE_URL: 'https://database.example.test',
    SUPABASE_SECRET_KEY: 'test-only-server-key',
    CORS_ORIGIN: 'https://cashier.example.test',
    INITIAL_ADMIN_USERNAME: 'ADMIN',
    INITIAL_ADMIN_PASSWORD: 'test-password',
    NODE_ENV: 'production',
    VERCEL_URL: 'unused.example.test'
  });
  // No real database/network access, including on accidental test regressions.
  globalThis.fetch = async () => { throw new Error('Network access forbidden in Netlify tests'); };
  const user = {
    id: 'test-admin', username: 'ADMIN', role: 'ADMINISTRATOR', active: true,
    password_changed_at: '2026-01-01T00:00:00.000Z',
    password_hash: require('bcryptjs').hashSync('test-password', 4)
  };
  const payload = { products: [], suppliers: [], customers: [], transactions: [], incoming: [], stocktakes: [] };
  const reads = [];
  const selections = [];
  let stateVersion = 1482;
  const supabasePath = require.resolve('@supabase/supabase-js');
  require(supabasePath);
  require.cache[supabasePath].exports = {
    createClient: () => ({
      from(table) {
        assert.ok(['app_users', 'app_state'].includes(table));
        reads.push(table);
        // Only the read methods needed by health, login, me, and state are stubbed.
        return {
          select(fields) { selections.push({ table, fields }); return this; }, eq() { return this; },
          async maybeSingle() { return { data: table === 'app_users' ? user : { payload, version: stateVersion }, error: null }; },
          async limit() { return { data: [{ id: 1 }], error: null }; }
        };
      }
    })
  };
  const { handler } = require('../netlify/functions/api');
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => { if (args[0] === 'API request') logs.push(JSON.parse(args[1])); };
  const invoke = (path, method = 'GET', body = '', headers = {}, isBase64Encoded = false) => handler({
    path, httpMethod: method, body, isBase64Encoded,
    headers: { host: 'cashier.example.test', 'x-nf-client-connection-ip': '192.0.2.10', ...headers },
    queryStringParameters: {}, requestContext: {}
  }, {});
  const jsonHeaders = { 'content-type': 'application/json' };
  const limitKb = Number(process.env.STATE_JSON_LIMIT_KB || 512);
  try {
    if (limitKb > 2048) {
      assert.equal((await invoke('/api/state')).statusCode, 503, 'out-of-range configuration must fail closed');
      assert.equal(reads.length, 0);
      console.log(`Netlify adapter: ${limitKb} KB configuration correctly rejected.`);
      return;
    }
    for (const prefix of ['/api', '/.netlify/functions/api']) {
      let response = await invoke(`${prefix}/health`);
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body).database, 'connected');
      for (const path of ['/state', '/state/version', '/auth/me', '/users']) {
        assert.equal((await invoke(prefix + path)).statusCode, 401, path);
      }
      for (const [method, path] of [['POST', '/users'], ['PUT', '/users/test'], ['DELETE', '/users/test'], ['PUT', '/users/test/password']]) {
        assert.equal((await invoke(prefix + path, method, '{}', jsonHeaders)).statusCode, 401, `${method} ${path}`);
      }
      response = await invoke(`${prefix}/state`, 'PUT', '{}', { 'content-type': 'text/plain' });
      assert.equal(response.statusCode, 415);
      response = await invoke(`${prefix}/state`, 'PUT', '{', jsonHeaders);
      assert.equal(response.statusCode, 401, 'authenticate before parsing malformed state');
      const body = JSON.stringify({ padding: 'x'.repeat(limitKb * 1024) });
      response = await invoke(`${prefix}/state`, 'PUT', Buffer.from(body).toString('base64'), jsonHeaders, true);
      assert.equal(response.statusCode, 413, 'base64-encoded state must use decoded byte size');
      response = await invoke(`${prefix}/state`, 'PUT', 'x'.repeat(limitKb * 1024), jsonHeaders);
      assert.equal(response.statusCode, 401, 'body at the limit must reach authentication');
      response = await invoke(`${prefix}/not-real`);
      assert.equal(response.statusCode, 404);
      assert.equal(JSON.parse(response.body).message, 'Endpoint tidak ditemukan.');
      assert.equal((await invoke(prefix)).statusCode, 404);
    }
    let response = await invoke('/api/auth/login', 'POST', JSON.stringify({ username: 'ADMIN', password: 'test-password' }), jsonHeaders);
    assert.equal(response.statusCode, 200);
    const cookie = response.headers['set-cookie'] || response.multiValueHeaders['set-cookie'][0];
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(flag), flag);
    assert.ok(!cookie.includes('Domain='), 'cookie must remain host-only');
    const session = { cookie: cookie.split(';')[0] };
    for (const prefix of ['/api', '/.netlify/functions/api']) {
      selections.length = 0;
      response = await invoke(`${prefix}/state/version`, 'GET', '', session);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { version: stateVersion }, 'metadata endpoint must never return payload');
      assert.ok(Buffer.byteLength(response.body) < 64, 'version response must remain tiny');
      assert.deepEqual(selections.filter(query => query.table === 'app_state'), [{ table: 'app_state', fields: 'version' }]);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['ratelimit-limit'], '180', 'use the existing state read limiter');
      stateVersion++;
    }
    assert.equal((await invoke('/api/auth/me', 'GET', '', session)).statusCode, 200);
    response = await invoke('/api/state', 'GET', '', session);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).maxRequestBytes, limitKb * 1024);
    response = await invoke('/api/auth/logout', 'POST');
    assert.equal(response.statusCode, 200);
    const clearedCookie = response.headers['set-cookie'] || response.multiValueHeaders['set-cookie'][0];
    assert.match(clearedCookie, /kasir_session=;/);
    assert.match(clearedCookie, /Secure/);
    response = await invoke('/api/state', 'OPTIONS', '', { origin: process.env.CORS_ORIGIN, 'access-control-request-method': 'PUT' });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], process.env.CORS_ORIGIN);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.equal((await invoke('/api/state', 'GET', '', { origin: 'https://unused.example.test' })).statusCode, 403);
    const readsBefore = reads.length;
    for (let attempt = 0; attempt < 11; attempt++) {
      response = await invoke('/api/auth/login', 'POST', '{}', {
        'content-type': 'text/plain', 'x-nf-client-connection-ip': '192.0.2.20',
        'x-forwarded-for': `198.51.100.${attempt + 1}`
      });
      assert.equal(response.statusCode, attempt < 10 ? 415 : 429, 'Netlify client IP must control login rate limits');
    }
    assert.equal((await invoke('/api/auth/login', 'POST', '{}', { 'content-type': 'text/plain', 'x-nf-client-connection-ip': '192.0.2.21' })).statusCode, 415);
    assert.equal(reads.length, readsBefore, 'rejected login must not reach database');
    for (const log of logs) {
      assert.deepEqual(Object.keys(log).sort(), ['method', 'endpoint', 'status', 'requestBytes', 'authenticated', 'durationMs'].sort());
      assert.ok(log.endpoint.startsWith('/api'), 'logged paths must use the Express API prefix');
    }
  } finally {
    console.info = originalInfo;
  }
  console.log(`Netlify adapter: ${limitKb} KB passed (database stub, no production access).`);
}
