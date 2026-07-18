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
- Perubahan state memicu sinyal Supabase Realtime tanpa payload sensitif; browser lain langsung mengambil data terbaru melalui API. Jika publishable key belum tersedia, build tetap berjalan dan memakai polling 2 detik; saat Realtime aktif, polling 8 detik tetap menjadi fallback.
- Restore/backup frontend hanya tersedia bagi administrator, tidak menyertakan user, dan menolak field sensitif.
- Instalasi baru memulai `products`, `suppliers`, `customers`, `transactions`, `incoming`, dan `stocktakes` sebagai array kosong.

## Pemeriksaan sebelum deploy

```bash
npm ci
npm run check
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
