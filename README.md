# Web Kasir Sumber Berkah Sidoguro

Aplikasi kasir statis di Netlify CDN dengan satu Netlify Function yang membungkus Express, Supabase, autentikasi JWT dalam cookie HttpOnly, dan kontrol akses `ADMINISTRATOR`/`KASIR`.

## Pengembangan lokal

1. Salin `.env.example` ke `.env` dan isi dengan konfigurasi development. Untuk lokal ubah `NODE_ENV=development` dan gunakan `CORS_ORIGIN=http://localhost:3000`. File `.env` sengaja tidak disertakan dalam project dan tidak boleh diunggah.
2. Gunakan database development yang sudah disiapkan. `server/schema.sql` hanya untuk instalasi database baru; migrasi hosting tidak memerlukan perubahan schema atau data production.
3. Jalankan:

   ```bash
   npm ci
   npm start
   ```

4. Buka `http://localhost:3000`. `PORT` opsional hanya untuk server Express lokal dan tidak dibutuhkan Netlify Function.

## Deployment satu project Netlify

Konfigurasi [netlify.toml](netlify.toml) memakai build command `npm run build`, publish directory `dist`, dan functions directory `netlify/functions`. Satu function [netlify/functions/api.js](netlify/functions/api.js) membungkus [server/app.js](server/app.js) dengan `serverless-http`.

Rewrite `/api/*` menuju `/.netlify/functions/api/:splat` diproses sebelum fallback SPA ke `index.html`. Express tetap menerima prefix `/api`; wrapper juga menormalkan URL function langsung. `/api` tanpa suffix tetap masuk API dan menghasilkan JSON 404. Frontend, assets, dan pages disajikan langsung oleh CDN, bukan Function. Tidak ada polling server atau health polling tambahan.

Langkah deployment:

1. Pertahankan project Supabase production yang sudah ada beserta schema dan datanya. Tidak perlu menjalankan SQL atau membuat database baru.
2. Import repository ke Netlify dengan root directory repository. Pengaturan build/publish/functions dibaca dari `netlify.toml`.
3. Di pengaturan environment variables Netlify untuk Production, isi:

   | Variabel | Nilai/ketentuan |
   | --- | --- |
   | `JWT_SECRET` | Secret yang sudah digunakan, minimal 32 karakter; hanya server |
   | `SUPABASE_URL` | URL HTTPS project Supabase yang sudah ada; tersedia saat build dan di Functions |
   | `SUPABASE_SECRET_KEY` | Secret/service-role key; hanya server |
   | `SUPABASE_ANON_KEY` | Publishable/anon key untuk Realtime; tersedia saat build dan sengaja masuk bundle frontend |
   | `STATE_JSON_LIMIT_KB` | Set `1536` untuk production saat ini; default `512`, maksimum `2048` |
   | `CORS_ORIGIN` | Isi setelah memperoleh URL production Netlify/custom domain: origin HTTPS tanpa path atau trailing slash |
   | `INITIAL_ADMIN_USERNAME` | Username administrator awal yang sudah ada |
   | `INITIAL_ADMIN_PASSWORD` | Nilai konfigurasi awal yang sudah digunakan, minimal 8 karakter; hanya server |
   | `NODE_ENV` | `production` |

   Semua variabel selain `SUPABASE_ANON_KEY` diperlukan di runtime Functions. `SUPABASE_URL` dan `SUPABASE_ANON_KEY` juga harus tersedia untuk Builds agar Realtime aktif. Gunakan UI/CLI Netlify untuk variabel runtime, bukan `[build.environment]` di TOML. Jika pilihan scope tersedia, gunakan Functions untuk secret, Builds untuk anon key, dan keduanya untuk URL. All scopes juga bekerja; script build hanya menyuntikkan URL dan anon key. Jangan masukkan `JWT_SECRET`, `SUPABASE_SECRET_KEY`, atau `INITIAL_ADMIN_PASSWORD` ke frontend.

   `CORS_ORIGIN` adalah daftar origin eksplisit (pisahkan dengan koma jika lebih dari satu). Tidak ada hostname Netlify yang di-hardcode atau izin otomatis bagi preview. Setelah URL production tersedia, isi nilai ini lalu redeploy. Gunakan database development terpisah untuk preview/testing, bukan kredensial production.

4. Deploy, lalu buka URL production Netlify. Frontend dan `/api` memakai origin yang sama; cookie login tetap `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, tanpa Domain. Pengguna perlu login kembali di hostname baru.
5. Setelah konfigurasi siap, periksa `/api/health` sekali secara manual; jangan jadikan polling. Respons sehat memuat `"database":"connected"`.
6. Login memakai akun yang sudah ada. Inisialisasi lama tetap hanya membuat administrator jika `INITIAL_ADMIN_USERNAME` belum ada, sehingga gunakan username yang sama agar tidak membuat akun tambahan. Pengujian lokal di bawah memakai stub dan tidak menyentuh Supabase production.

Jangan menambahkan `PORT` ke environment Netlify. Jangan memakai anon key sebagai `SUPABASE_SECRET_KEY`; gunakan secret/service-role key dan jangan pernah memasukkannya ke frontend.

`vercel.json` dan `api/index.js` tetap disimpan sebagai referensi/rollback dan tidak digunakan Netlify. Jika rollback ke Vercel, isi origin Vercel secara eksplisit dalam `CORS_ORIGIN`; runtime tidak lagi membaca `VERCEL_URL` atau `VERCEL_PROJECT_PRODUCTION_URL`.

## Keamanan dan data

- Password hanya disimpan sebagai bcrypt hash di `app_users` dan tidak menjadi bagian dari app state/backup/API response.
- JWT disimpan pada cookie `HttpOnly`, `Secure`, `SameSite=Lax` di production; frontend tidak menyimpan token atau password di localStorage.
- Endpoint user admin dilindungi role, sedangkan ganti password sendiri mewajibkan password lama.
- Kasir menerima state tanpa harga modal/profit dan tidak dapat mengubah master data, menghapus transaksi, atau mengelola user melalui API.
- Supabase Realtime tetap utama; versi event yang sama tidak memicu download. Tanpa Realtime, tab terlihat memeriksa `GET /api/state/version` setiap 30 detik dan hanya mengambil state lengkap jika versinya berbeda. Endpoint ini memerlukan autentikasi, memakai limiter baca yang sama, memilih hanya kolom `version`, dan mengembalikan misalnya `{"version":1482}` tanpa payload atau perubahan database. Polling berhenti saat Realtime terhubung atau tab tersembunyi; focus/visibility/online juga memeriksa versi dahulu. Pemeriksaan tidak tumpang tindih, dibatalkan saat logout, dan respons sesi lama diabaikan. Ini mengurangi bandwidth saat data tidak berubah; jumlah invocation fallback tetap satu per 30 detik per tab aktif.
- Restore/backup frontend hanya tersedia bagi administrator, tidak menyertakan user, dan menolak field sensitif.
- Instalasi baru memulai `products`, `suppliers`, `customers`, `transactions`, `incoming`, dan `stocktakes` sebagai array kosong.

## Perlindungan trafik

- Penyimpanan state di-debounce 1 detik. Respons 400/403/413 tidak dicoba ulang otomatis; gangguan jaringan, 429, dan 5xx memakai exponential backoff dengan maksimum lima retry otomatis.
- Browser memeriksa ukuran state sebelum upload. Default maksimum request state adalah 512 KB. Login dan mutasi user dibatasi 8 KB.
- `PUT /api/state` dibatasi 60 request per 5 menit per user, `GET /api/state` 180 per 5 menit per user, login 10 percobaan per 15 menit per IP, dan seluruh API 300 request per 5 menit per IP. Rate limit ini bersifat ringan/in-memory pada function instance; perlindungan utama terhadap storm tetap retry yang terbatas.
- Endpoint JSON menolak Content-Type yang salah, JSON rusak, dan payload berlebih dengan status 415, 400, atau 413.
- Log API tidak memuat body, password, cookie, token, atau authorization header. Semua write/error dicatat; successful GET di-sample 10%. Field log: method, endpoint, status, perkiraan ukuran request, status autentikasi, dan durasi.

Karena data operasional disimpan sebagai satu dokumen JSON, ukur backup sebelum deploy. Ukuran file backup yang pretty-printed bukan ukuran request sebenarnya; untuk mengukur bentuk compact jalankan:

```bash
node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync('PATH-BACKUP.json','utf8'));console.log(Buffer.byteLength(JSON.stringify({state:data,expectedVersion:0})))"
```

Jika hasilnya mendekati atau melebihi 524288 byte, set `STATE_JSON_LIMIT_KB` sedikit di atas kebutuhan (maksimum 2048), lalu rencanakan pengarsipan transaksi lama. Dengan state production saat ini sebesar 1.013.152 byte (sekitar 989 KB), nilai `1536` direkomendasikan agar tersedia ruang pertumbuhan tanpa membuka request hingga batas maksimum. Jangan menaikkan limit tanpa ukuran nyata.

## Pemeriksaan sebelum deploy

```bash
npm ci
npm run check
npm test
npm run build
git diff --check
```

Build selalu membersihkan `dist`, menyalin hanya `index.html`, `assets`, dan `pages`, lalu gagal bila menemukan function API, file server, konfigurasi hosting, schema, package manifest, atau `.env` di publish directory. Mekanisme build Realtime tetap menyuntikkan hanya URL dan publishable/anon key.

`npm test` memeriksa HTTP Express dan wrapper Netlify dengan konfigurasi dummy serta stub database (tanpa akses jaringan database). Cakupan meliputi prefix API, health, autentikasi, CORS, cookie HTTPS, rate limit, dan batas payload default/1536/2048 KB, ditambah endpoint versi serta simulasi timer/fetch browser untuk polling ringan, perubahan versi, Realtime, non-overlap, dan pergantian sesi/logout. `npm run check` menjaga konstanta dan guard retry/polling, debounce, abort saat logout, ukuran upload, serta urutan autentikasi sebelum parsing state.

Untuk emulasi routing/CDN lokal opsional, setelah build jalankan `npx netlify-cli dev --offline --framework '#static' --dir dist --port 3000 --no-open`. CLI tidak menjadi dependency production. Port 3000 penting karena frontend development mengarahkan API ke port tersebut. Gunakan konfigurasi development/non-production, periksa `/`, `/assets/js/app.js`, `/api/health`, `/api/state` tanpa login (401), body state berlebih (413), Content-Type salah (415), dan API tidak dikenal (404 JSON). Tanpa konfigurasi database, health mengembalikan 503, bukan halaman SPA. Jangan menguji login/health dengan kredensial production jika tidak ingin memicu inisialisasi admin yang sudah ada.

Catatan pengujian Windows: Netlify CLI 27.8.0 meneruskan path static bertingkat dengan backslash saat pencocokan file, sehingga proxy lokal mengembalikan 403 untuk assets/pages. File yang sama berhasil 200 melalui static server internal CLI dengan slash URL biasa; routing API tetap berhasil. Ini batasan emulator yang ditemukan saat migrasi, bukan perubahan aplikasi. Untuk verifikasi browser lengkap gunakan lingkungan Linux/WSL atau periksa deployment Netlify sebelum memindahkan pemakaian harian.

Rujukan: [Express di Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/) dan [environment variables Functions](https://docs.netlify.com/build/functions/environment-variables/).

## Struktur deployment

```text
dist/                    # Satu-satunya publish directory (frontend)
netlify/functions/api.js # Satu wrapper Express untuk Netlify Function
netlify.toml             # Build, publish, functions, dan rewrite
api/index.js             # Referensi/rollback Vercel; tidak dipakai Netlify
vercel.json              # Referensi/rollback Vercel; tidak dipakai Netlify
server/app.js            # Express app, tanpa app.listen()
server/index.js          # Server development lokal
server/schema.sql        # Skema Supabase idempotent
scripts/build.js         # Build dan validasi dist
scripts/check.js         # Pemeriksaan syntax/secret frontend
```
