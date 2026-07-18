const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
require('dotenv').config({ quiet: true });

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
if (process.env.NETLIFY === 'true' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)) {
  console.warn('Peringatan: SUPABASE_URL atau SUPABASE_ANON_KEY belum tersedia. Build dilanjutkan dengan polling sinkronisasi sebagai fallback.');
}

fs.rmSync(dist, { recursive: true, force: true });
buildSync({ entryPoints: [path.join(root, 'assets/js/sidebar.jsx')], bundle: true, minify: true, outfile: path.join(root, 'assets/js/sidebar.js') });
buildSync({
  entryPoints: [path.join(root, 'scripts/realtime-client.js')],
  bundle: true,
  minify: true,
  platform: 'browser',
  outfile: path.join(root, 'assets/js/realtime.js'),
  define: {
    __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL || ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(process.env.SUPABASE_ANON_KEY || '')
  }
});
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
for (const directory of ['assets', 'pages']) fs.cpSync(path.join(root, directory), path.join(dist, directory), { recursive: true });
fs.rmSync(path.join(dist, 'assets/js/sidebar.jsx'), { force: true });

const forbiddenNames = new Set(['.env', 'schema.sql', 'package.json', 'package-lock.json']);
const forbiddenDirectories = new Set(['server', 'netlify', 'node_modules', '.git']);
function validate(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (forbiddenNames.has(entry.name) || forbiddenDirectories.has(entry.name)) throw new Error(`Build tidak aman: ${path.relative(dist, path.join(directory, entry.name))} ditemukan di dist.`);
    if (entry.isDirectory()) validate(path.join(directory, entry.name));
  }
}
validate(dist);
console.log('Build frontend selesai dan dist lolos pemeriksaan file sensitif.');
