# Web Kasir Sumber Berkah Sidoguro

Aplikasi kasir statis dengan Express pada Vercel Functions, Supabase, autentikasi JWT dalam cookie HttpOnly, dan kontrol akses `ADMINISTRATOR`/`KASIR`.

## Pengembangan lokal

1. Salin `.env.example` ke `.env` dan isi dengan konfigurasi development. Untuk lokal ubah `NODE_ENV=development` dan gunakan `CORS_ORIGIN=http://localhost:3000`. File `.env` sengaja tidak disertakan dalam project dan tidak boleh diunggah.
2. Jalankan `server/schema.sql` di SQL Editor Supabase.
3. Jalankan:

   ```bash
   npm ci
   npm start
   ```

4. Buka `http://localhost:3000`. `PORT` opsional hanya untuk server lokal dan tidak dibutuhkan Vercel Functions.

## Deployment satu project Vercel

Konfigurasi [vercel.json](vercel.json) menjalankan `npm run build`, memublikasikan frontend dari `dist`, dan mengarahkan `/api/*` ke Express app di [api/index.js](api/index.js). Rewrite API diproses sebelum fallback SPA ke `index.html`, sehingga API dan frontend tetap berjalan pada origin yang sama.

Langkah deployment:

1. Buat project Supabase baru lalu jalankan seluruh [server/schema.sql](server/schema.sql) di SQL Editor. Script idempotent dan tidak berisi produk, supplier, pelanggan, transaksi, stok, user, atau password seed.
2. Import repository ini melalui **Vercel Dashboard → Add New → Project**. Gunakan root directory repository; build command dan output directory otomatis dibaca dari `vercel.json`.
3. Di **Vercel → Project Settings → Environment Variables**, isi untuk environment Production dan Preview:

   | Variabel | Nilai/ketentuan |
   | --- | --- |
   | `JWT_SECRET` | Random secret minimal 32 karakter |
   | `SUPABASE_URL` | URL HTTPS project Supabase |
   | `SUPABASE_SECRET_KEY` | Secret/service-role key; hanya server |
   | `SUPABASE_ANON_KEY` | Publishable/anon key Supabase untuk notifikasi Realtime; aman berada di bundle frontend |
   | `STATE_JSON_LIMIT_KB` | Opsional, default `512`; hanya naikkan setelah mengukur backup, maksimum `2048` |
   | `CORS_ORIGIN` | URL production Vercel/custom domain, misalnya `https://web-kasir-sumber-berkah.vercel.app` |
   | `INITIAL_ADMIN_USERNAME` | Misalnya `ADMIN` |
   | `INITIAL_ADMIN_PASSWORD` | Password awal kuat, minimal 8 karakter |
   | `NODE_ENV` | `production` |

   Vercel otomatis memasukkan domain deployment dan production project ke daftar CORS melalui `VERCEL_URL` dan `VERCEL_PROJECT_PRODUCTION_URL`. `CORS_ORIGIN` tetap wajib diisi agar custom domain atau domain utama eksplisit diizinkan.

4. Deploy project, lalu buka URL production yang diberikan Vercel.
5. Uji `https://DOMAIN-ANDA/api/health`. Respons sehat memuat `"database":"connected"`.
6. Login dengan initial admin. Admin hanya dibuat bila username tersebut belum ada; deploy ulang tidak menggandakan admin atau mereset passwordnya.
7. Ganti password admin melalui menu **Ganti Password** setelah login pertama.

Jangan menambahkan `PORT` ke environment Vercel. Jangan memakai anon key sebagai `SUPABASE_SECRET_KEY`; gunakan secret/service-role key dan jangan pernah memasukkannya ke frontend.

## Keamanan dan data

- Password hanya disimpan sebagai bcrypt hash di `app_users` dan tidak menjadi bagian dari app state/backup/API response.
- JWT disimpan pada cookie `HttpOnly`, `Secure`, `SameSite=Lax` di production; frontend tidak menyimpan token atau password di localStorage.
- Endpoint user admin dilindungi role, sedangkan ganti password sendiri mewajibkan password lama.
- Kasir menerima state tanpa harga modal/profit dan tidak dapat mengubah master data, menghapus transaksi, atau mengelola user melalui API.
- Perubahan state memicu sinyal Supabase Realtime tanpa payload sensitif; browser lain langsung mengambil data terbaru melalui API. Polling tidak berjalan saat Realtime terhubung. Jika Realtime tidak tersedia, satu fallback non-overlap berjalan setiap 30 detik dan berhenti saat tab tersembunyi.
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
```

Build selalu membersihkan `dist`, menyalin hanya `index.html`, `assets`, dan `pages`, lalu gagal bila menemukan function API, file server, konfigurasi Vercel, schema, package manifest, atau `.env` di publish directory.

## Struktur deployment

```text
dist/                    # Satu-satunya publish directory (frontend)
api/index.js             # Entry point Express untuk Vercel Function
vercel.json              # Build, output directory, rewrite API, dan fallback SPA
server/app.js            # Express app, tanpa app.listen()
server/index.js          # Server development lokal
server/schema.sql        # Skema Supabase idempotent
scripts/build.js         # Build dan validasi dist
scripts/check.js         # Pemeriksaan syntax/secret frontend
```
