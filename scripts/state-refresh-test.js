const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/app.js'), 'utf8');
const startup = source.indexOf('\nstate=loadState();');
assert.ok(startup > 0);
const logoutSource = source.slice(source.indexOf('function logout(){'), source.indexOf('function goPage('));
const listeners = source.match(/^(?:window|document)\.addEventListener\("(?:focus|online|visibilitychange)".*$/gm);
assert.equal(listeners.length, 3);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const fullState = version => response({ version, state: { products: [] }, maxRequestBytes: 1536 * 1024 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Execute the real refresh functions and browser listeners with fake time/network.
// UI startup is excluded; no production code needs test-only exports.
function browser() {
  const requests = [], replies = [], timers = new Map(), events = new Map();
  let timerId = 0, connected = false, onChange, onStatus;
  const element = { classList: { contains: () => false, add() {}, remove() {} } };
  const context = vm.createContext({
    location: { hostname: 'cashier.example.test', port: '', protocol: 'https:' },
    document: { visibilityState: 'visible', querySelector: () => element, addEventListener: (name, callback) => events.set(name, callback) },
    window: {
      addEventListener: (name, callback) => events.set(name, callback),
      KASIR_REALTIME: {
        isConnected: () => connected,
        subscribe(change, status) { onChange = change; onStatus = status; },
        unsubscribe() { connected = false; }
      }
    },
    navigator: { onLine: true }, AbortController, Blob,
    AbortSignal: { any: AbortSignal.any.bind(AbortSignal) },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      requests.push({ url, ...options });
      if (url.endsWith('/auth/logout')) return response({ ok: true });
      assert.ok(replies.length, `unexpected request: ${url}`);
      return replies.shift();
    }
  });
  const evaluate = code => vm.runInContext(code, context);
  evaluate(source.slice(0, startup) + '\n' + logoutSource + '\n' + listeners.join('\n'));
  evaluate(`
    apiToken="cookie";sessionUser={id:"same-user"};sessionGeneration=1;
    state={products:[],currentUser:"ADMIN"};serverStateVersion=1;
    migrateState=value=>value;normalizeInMemoryState=()=>{};renderAll=()=>{};toast=()=>{};
  `);
  return {
    evaluate, context, requests, replies, timers,
    paths: () => requests.map(request => request.url),
    async event(name) { await events.get(name)(); await settle(); },
    connected(value) { connected = value; onStatus?.(value); },
    change(version) { onChange(version); },
    tick() {
      assert.equal(timers.size, 1, 'only one fallback timer may be scheduled');
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 30000, 'fallback must wait 30 seconds');
      timers.delete(id);
      return timer.callback();
    }
  };
}

test('unchanged fallback polls metadata only, every 30 seconds', async () => {
  const b = browser();
  b.evaluate('startServerRefresh()');
  for (let index = 0; index < 3; index++) {
    b.replies.push(response({ version: 1 }));
    await b.tick();
    assert.equal(b.timers.size, 1);
  }
  assert.deepEqual(b.paths(), Array(3).fill('/api/state/version'));
  for (const request of b.requests) {
    assert.equal(request.credentials, 'include');
    assert.equal(request.cache, 'no-store');
    assert.ok(request.signal);
  }
});

test('changed version downloads state once and then resumes metadata-only checks', async () => {
  const b = browser();
  b.replies.push(response({ version: 2 }), fullState(2), response({ version: 2 }));
  b.evaluate('startServerRefresh()');
  await b.tick();
  assert.equal(b.evaluate('serverStateVersion'), 2);
  assert.equal(b.evaluate('serverStateRequestLimit'), 1536 * 1024);
  await b.tick();
  assert.deepEqual(b.paths(), ['/api/state/version', '/api/state', '/api/state/version']);
});

test('Realtime connection and hidden tabs stop fallback polling', async () => {
  const b = browser();
  b.evaluate('startServerRefresh()');
  b.connected(true);
  assert.equal(b.timers.size, 0);
  b.evaluate('scheduleFallbackRefresh()');
  assert.equal(b.timers.size, 0);
  b.connected(false);
  assert.equal(b.timers.size, 1);
  b.context.document.visibilityState = 'hidden';
  await b.event('visibilitychange');
  b.evaluate('scheduleFallbackRefresh()');
  await b.evaluate('refreshServerState()');
  assert.equal(b.timers.size, 0);
  assert.deepEqual(b.paths(), []);
});

test('version and full-state requests share one non-overlapping refresh lock', async () => {
  const b = browser(), version = deferred(), full = deferred();
  b.replies.push(version.promise, full.promise);
  const work = b.evaluate('refreshServerState()');
  await b.evaluate('refreshServerState()');
  assert.deepEqual(b.paths(), ['/api/state/version']);
  version.resolve(response({ version: 2 }));
  await settle();
  await b.evaluate('refreshServerState()');
  assert.deepEqual(b.paths(), ['/api/state/version', '/api/state']);
  full.resolve(fullState(2));
  await work;
  assert.equal(b.evaluate('refreshInFlight'), false);
});

test('Realtime skips unchanged versions, downloads changed ones, and checks missing versions', async () => {
  const b = browser();
  b.connected(true);
  b.evaluate('startServerRefresh()');
  b.change(1);
  await settle();
  assert.deepEqual(b.paths(), []);
  b.replies.push(fullState(2));
  b.change(2);
  await settle();
  assert.deepEqual(b.paths(), ['/api/state']);
  b.replies.push(response({ version: 2 }));
  b.change(undefined);
  await settle();
  assert.deepEqual(b.paths(), ['/api/state', '/api/state/version']);
  assert.equal(b.timers.size, 0);
});

test('Realtime change during a metadata check is retained without overlapping requests', async () => {
  const b = browser(), version = deferred();
  b.evaluate('startServerRefresh()');
  b.replies.push(version.promise, fullState(2));
  const work = b.tick();
  b.connected(true);
  b.change(2);
  b.change(2);
  assert.deepEqual(b.paths(), ['/api/state/version']);
  version.resolve(response({ version: 1 }));
  await work;
  await settle();
  assert.deepEqual(b.paths(), ['/api/state/version', '/api/state']);
  assert.equal(b.evaluate('serverStateVersion'), 2);
  assert.equal(b.timers.size, 0);
});

test('focus, visibility and online use metadata before downloading state', async () => {
  for (const event of ['focus', 'visibilitychange', 'online']) {
    const b = browser();
    b.replies.push(response({ version: 1 }));
    await b.event(event);
    assert.deepEqual(b.paths(), ['/api/state/version'], event);
  }
});

test('failed or malformed metadata never triggers a full download or fast retry', async () => {
  for (const reply of [response({}, 503), response({ version: null }), response({ version: 'bad' })]) {
    const b = browser();
    b.replies.push(reply);
    b.evaluate('startServerRefresh()');
    await b.tick();
    assert.deepEqual(b.paths(), ['/api/state/version']);
    assert.equal(b.timers.size, 1);
    assert.equal([...b.timers.values()][0].delay, 30000);
  }
});

test('logout aborts checks; stale responses cannot download state, log out a new session, or reschedule', async () => {
  for (const status of [200, 401]) {
    const b = browser(), version = deferred();
    b.replies.push(version.promise);
    b.evaluate('startServerRefresh()');
    const work = b.tick();
    b.evaluate('logout()');
    assert.equal(b.requests[0].signal.aborted, true);
    assert.equal(b.timers.size, 0);
    // Log back in as the same user, deliberately ignoring cancellation in fetch.
    b.evaluate('sessionGeneration++;apiToken="cookie";sessionUser={id:"same-user"};serverStateVersion=9');
    version.resolve(response({ version: 2 }, status));
    await work;
    assert.equal(b.evaluate('serverStateVersion'), 9);
    assert.equal(b.evaluate('apiToken'), 'cookie');
    assert.deepEqual(b.paths(), ['/api/state/version', '/api/auth/logout']);
    assert.equal(b.timers.size, 0);
  }
});

test('401 during the active session still logs out', async () => {
  const b = browser();
  b.replies.push(response({}, 401));
  await b.evaluate('refreshServerState()');
  assert.equal(b.evaluate('apiToken'), '');
  assert.deepEqual(b.paths(), ['/api/state/version', '/api/auth/logout']);
});

test('local edits or hidden tabs during metadata fetch prevent a full download', async () => {
  for (const change of ['stateDirty=true', 'document.visibilityState="hidden"']) {
    const b = browser(), version = deferred();
    b.replies.push(version.promise);
    const work = b.evaluate('refreshServerState()');
    b.evaluate(change);
    version.resolve(response({ version: 2 }));
    await work;
    assert.deepEqual(b.paths(), ['/api/state/version']);
    assert.equal(b.evaluate('serverStateVersion'), 1);
  }
});

test('stale full-state response cannot overwrite a new session or pending local edits', async () => {
  for (const change of ['sessionGeneration++;serverStateVersion=9', 'stateDirty=true;serverStateVersion=9']) {
    const b = browser(), full = deferred();
    b.replies.push(response({ version: 2 }), full.promise);
    const work = b.evaluate('refreshServerState()');
    await settle();
    b.evaluate(change);
    full.resolve(fullState(2));
    await work;
    assert.equal(b.evaluate('serverStateVersion'), 9);
  }
});

test('Realtime during PUT is queued; our saved version needs no redundant GET', async () => {
  const b = browser(), write = deferred();
  b.connected(true);
  b.evaluate('startServerRefresh();stateDirty=true');
  b.replies.push(write.promise);
  const work = b.evaluate('syncServerState()');
  b.change(2);
  assert.equal(b.evaluate('pendingRealtimeRefresh.version'), 2);
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].method, 'PUT');
  write.resolve(response({ version: 2 }));
  await work;
  await settle();
  assert.equal(b.evaluate('stateDirty'), false);
  assert.equal(b.evaluate('syncInFlight'), false);
  assert.equal(b.evaluate('pendingRealtimeRefresh'), null);
  assert.equal(b.evaluate('serverStateVersion'), 2);
  assert.equal(b.requests.length, 1, 'same-version event must cause no GET');
  assert.equal(b.timers.size, 0, 'no polling while Realtime is connected');
});

test('newer Realtime version during PUT is fetched after the successful write', async () => {
  const b = browser(), write = deferred();
  b.connected(true);
  b.evaluate('startServerRefresh();stateDirty=true');
  b.replies.push(write.promise, fullState(3));
  const work = b.evaluate('syncServerState()');
  b.change(3);
  assert.equal(b.requests.length, 1, 'refresh must wait for the PUT');
  write.resolve(response({ version: 2 }));
  await work;
  await settle();
  assert.equal(b.evaluate('serverStateVersion'), 3);
  assert.equal(b.evaluate('pendingRealtimeRefresh'), null);
  assert.deepEqual(b.requests.map(request => request.method || 'GET'), ['PUT', 'GET']);
  assert.deepEqual(b.paths(), ['/api/state', '/api/state']);
  assert.equal(b.timers.size, 0);
});

test('Realtime while dirty before PUT is retained until the save completes', async () => {
  const b = browser();
  b.connected(true);
  b.evaluate('startServerRefresh();stateDirty=true');
  b.change(3);
  assert.equal(b.evaluate('pendingRealtimeRefresh.version'), 3);
  assert.deepEqual(b.paths(), []);
  b.replies.push(response({ version: 2 }), fullState(3));
  await b.evaluate('syncServerState()');
  await settle();
  assert.equal(b.evaluate('serverStateVersion'), 3);
  assert.equal(b.requests.length, 2);
});

test('refresh completion during PUT must not consume the pending Realtime event', async () => {
  const b = browser(), version = deferred(), write = deferred();
  b.connected(true);
  b.evaluate('startServerRefresh()');
  b.replies.push(version.promise, write.promise, fullState(3));
  const refresh = b.evaluate('refreshServerState()');
  b.evaluate('stateDirty=true');
  const save = b.evaluate('syncServerState()');
  b.change(3);
  version.resolve(response({ version: 1 }));
  await refresh;
  assert.equal(b.evaluate('pendingRealtimeRefresh.version'), 3);
  assert.equal(b.requests.length, 2);
  write.resolve(response({ version: 2 }));
  await save;
  await settle();
  assert.equal(b.evaluate('serverStateVersion'), 3);
  assert.deepEqual(b.paths(), ['/api/state/version', '/api/state', '/api/state']);
});

test('successful PUT waits for an existing refresh before consuming the pending event', async () => {
  const b = browser(), version = deferred();
  b.connected(true);
  b.evaluate('startServerRefresh()');
  b.replies.push(version.promise, response({ version: 2 }), fullState(3));
  const refresh = b.evaluate('refreshServerState()');
  b.evaluate('stateDirty=true');
  b.change(3);
  await b.evaluate('syncServerState()');
  assert.equal(b.evaluate('pendingRealtimeRefresh.version'), 3);
  assert.equal(b.requests.length, 2, 'no overlapping refresh after PUT');
  version.resolve(response({ version: 2 }));
  await refresh;
  await settle();
  assert.equal(b.evaluate('serverStateVersion'), 3);
  assert.equal(b.requests.length, 3);
});

test('failed PUT retains pending Realtime work for a later successful retry', async () => {
  const b = browser();
  b.connected(true);
  b.evaluate('startServerRefresh();stateDirty=true');
  b.change(3);
  b.replies.push(response({}, 503));
  await b.evaluate('syncServerState()');
  assert.equal(b.evaluate('pendingRealtimeRefresh.version'), 3);
  assert.equal(b.evaluate('stateDirty'), true);
  assert.equal(b.requests.length, 1);
  const [id, retry] = [...b.timers.entries()][0];
  assert.equal(retry.delay, 2000, 'existing bounded write retry is unchanged');
  b.timers.delete(id);
  b.replies.push(response({ version: 2 }), fullState(3));
  await retry.callback();
  await settle();
  assert.equal(b.evaluate('serverStateVersion'), 3);
  assert.equal(b.evaluate('pendingRealtimeRefresh'), null);
  assert.equal(b.timers.size, 0);
});

test('logout during PUT or response parsing clears pending work and protects a new session', async () => {
  for (const duringBody of [false, true]) {
    const b = browser(), write = deferred();
    b.connected(true);
    b.evaluate('startServerRefresh();stateDirty=true');
    b.replies.push(duringBody ? { ok: true, status: 200, json: () => write.promise } : write.promise);
    const work = b.evaluate('syncServerState()');
    if (duringBody) await settle();
    b.change(3);
    b.evaluate('logout()');
    assert.equal(b.requests[0].signal.aborted, true);
    assert.equal(b.evaluate('pendingRealtimeRefresh'), null);
    b.evaluate('sessionGeneration++;apiToken="cookie";sessionUser={id:"same-user"};serverStateVersion=9');
    b.change(4); // Callback still belongs to the old session.
    write.resolve(duringBody ? { version: 2 } : response({ version: 2 }));
    await work;
    await settle();
    assert.equal(b.evaluate('serverStateVersion'), 9);
    assert.equal(b.evaluate('pendingRealtimeRefresh'), null);
    assert.deepEqual(b.paths(), ['/api/state', '/api/auth/logout']);
    assert.equal(b.timers.size, 0);
  }
});
