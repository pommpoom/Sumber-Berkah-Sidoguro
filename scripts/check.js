const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
for (const file of ['assets/js/app.js', 'assets/js/page-loader.js', 'api/index.js', 'netlify/functions/api.js', 'server/app.js', 'server/index.js', 'scripts/build.js', 'scripts/realtime-client.js', 'scripts/netlify-test.js', 'scripts/state-refresh-test.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
}
const frontendFiles = ['index.html', ...fs.readdirSync(path.join(root, 'assets/js')).map(name => `assets/js/${name}`)];
const forbidden = /(SUPABASE_SECRET_KEY|JWT_SECRET|INITIAL_ADMIN_PASSWORD)\s*[=:]\s*["'][^"']+["']/;
for (const file of frontendFiles) {
  const full = path.join(root, file);
  if (fs.statSync(full).isFile() && forbidden.test(fs.readFileSync(full, 'utf8'))) throw new Error(`Secret terdeteksi di ${file}`);
}
const appSource = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
if (/setInterval\s*\(/.test(appSource)) throw new Error('Polling setInterval tidak boleh digunakan untuk sinkronisasi server.');
for (const required of [
  'MAX_AUTOMATIC_SYNC_RETRIES = 5', 'FALLBACK_REFRESH_MS = 30000', 'SYNC_DEBOUNCE_MS = 1000',
  'syncFailureCount<=MAX_AUTOMATIC_SYNC_RETRIES', 'queueServerSync(delay=SYNC_DEBOUNCE_MS)',
  'stateDirty=!sameValue(statePayload(),lastSyncedState)', 'if(stateDirty){syncFailureCount=0;queueServerSync()}',
  'if(!apiToken||realtimeConnected()||document.visibilityState==="hidden")return',
  'if(!realtimeConnected())await refreshServerState({notify:true});if(activeGeneration===sessionGeneration)scheduleFallbackRefresh()',
  'if(connected)clearTimeout(serverRefreshTimer);else scheduleFallbackRefresh()',
  '`${API_BASE_URL}/state/version`', 'remoteVersionHint===serverStateVersion',
  'stateDirty||syncInFlight||refreshInFlight||document.visibilityState==="hidden"',
  'new Blob([requestBody]).size>serverStateRequestLimit',
  'error.retryable=response.status===408||response.status===429||response.status>=500',
  'sessionGeneration++', 'activeGeneration!==sessionGeneration',
  'syncController?.abort()', 'refreshController?.abort()', 'window.KASIR_REALTIME?.unsubscribe()'
]) {
  if (!appSource.includes(required)) throw new Error(`Perlindungan sinkronisasi hilang: ${required}`);
}
for (const required of [
  'configuredStateLimitKb <= 2048 ? configuredStateLimitKb : 512',
  'requestMetadataLog', 'stateReadLimiter', 'stateWriteLimiter', 'loginLimiter', 'apiLimiter',
  "app.get('/api/state/version', requireAuth, stateReadLimiter",
  'rejectOversizedBody(STATE_JSON_LIMIT), requireAuth, ensureReady, stateWriteLimiter, parseStateJson'
]) {
  if (!serverSource.includes(required)) throw new Error(`Perlindungan API hilang: ${required}`);
}
console.log('Pemeriksaan syntax dan secret frontend berhasil.');
