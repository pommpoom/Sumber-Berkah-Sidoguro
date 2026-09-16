const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
for (const file of ['assets/js/app.js', 'assets/js/page-loader.js', 'api/index.js', 'server/app.js', 'server/index.js', 'scripts/build.js', 'scripts/realtime-client.js']) {
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
for (const required of ['MAX_AUTOMATIC_SYNC_RETRIES', 'FALLBACK_REFRESH_MS = 30000', 'refreshInFlight', 'syncController', 'sessionGeneration']) {
  if (!appSource.includes(required)) throw new Error(`Perlindungan sinkronisasi hilang: ${required}`);
}
for (const required of ['STATE_JSON_LIMIT', 'stateWriteLimiter', 'requestMetadataLog', 'requireJson']) {
  if (!serverSource.includes(required)) throw new Error(`Perlindungan API hilang: ${required}`);
}
console.log('Pemeriksaan syntax dan secret frontend berhasil.');
