# Web Kasir Sumber Berkah Sidoguro

Aplikasi kasir statis dengan Express pada Netlify Functions, Supabase, autentikasi JWT dalam cookie HttpOnly, dan kontrol akses `ADMINISTRATOR`/`KASIR`.

## Pengembangan lokal

1. Salin `.env.example` ke `.env` dan isi dengan konfigurasi development. Untuk lokal ubah `NODE_ENV=development` dan gunakan `CORS_ORIGIN=http://localhost:3000`. File `.env` sengaja tidak disertakan dalam project dan tidak boleh diunggah.
2. Jalankan `server/schema.sql` di SQL Editor Supabase.
3. Jalankan:

   ```bash
   npm ci
   npm start
   ```

4. Buka `http://localhost:3000`. `PORT` opsional hanya untuk server lokal dan tidak dibutuhkan Netlify Functions.

## Deployment satu site Netlify

Konfigurasi [netlify.toml](netlify.toml) menjalankan `npm run build`, memublikasikan hanya `dist`, dan membangun Function dari `netlify/functions`. Redirect `/api/*` diproses sebelum fallback frontend `/*`, sehingga API dan refresh halaman dapat berjalan pada origin yang sama.

Langkah deployment:

1. Buat project Supabase baru lalu jalankan seluruh [server/schema.sql](server/schema.sql) di SQL Editor. Script idempotent dan tidak berisi produk, supplier, pelanggan, transaksi, stok, user, atau password seed.
2. Di **Netlify → Site configuration → Environment variables**, isi:

   | Variabel | Nilai/ketentuan |
   | --- | --- |
   | `JWT_SECRET` | Random secret minimal 32 karakter |
   | `SUPABASE_URL` | URL HTTPS project Supabase |
   | `SUPABASE_SECRET_KEY` | Secret/service-role key; hanya server |
   | `SUPABASE_ANON_KEY` | Publishable/anon key Supabase untuk notifikasi Realtime; aman berada di bundle frontend |
   | `CORS_ORIGIN` | `https://kasir-sumberberkah.netlify.app` |
   | `INITIAL_ADMIN_USERNAME` | Misalnya `ADMIN` |
   | `INITIAL_ADMIN_PASSWORD` | Password awal kuat, minimal 8 karakter |
   | `NODE_ENV` | `production` |

3. Deploy site. Build command, publish directory, dan functions directory sudah berasal dari `netlify.toml`.
4. Uji `https://kasir-sumberberkah.netlify.app/api/health`. Respons sehat memuat `"database":"connected"`.
5. Login dengan initial admin. Admin hanya dibuat bila username tersebut belum ada; deploy ulang tidak menggandakan admin atau mereset passwordnya.
6. Ganti password admin melalui menu **Ganti Password** setelah login pertama.

Jangan menambahkan `PORT` ke environment Netlify. Jangan memakai anon key sebagai `SUPABASE_SECRET_KEY`; gunakan secret/service-role key dan jangan pernah memasukkannya ke frontend.

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

Build selalu membersihkan `dist`, menyalin hanya `index.html`, `assets`, dan `pages`, lalu gagal bila menemukan file/folder server, Netlify, schema, package manifest, atau `.env` di publish directory.

## Struktur deployment

```text
dist/                    # Satu-satunya publish directory (frontend)
netlify/functions/api.js # Adapter serverless-http
server/app.js            # Express app, tanpa app.listen()
server/index.js          # Server development lokal
server/schema.sql        # Skema Supabase idempotent
scripts/build.js         # Build dan validasi dist
scripts/check.js         # Pemeriksaan syntax/secret frontend
```
