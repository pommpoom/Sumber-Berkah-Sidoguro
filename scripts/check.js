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
console.log('Pemeriksaan syntax dan secret frontend berhasil.');
