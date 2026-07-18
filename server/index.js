const app = require('./app');
const express = require('express');
const path = require('path');

const port = Number(process.env.PORT || 3000);
const publishRoot = path.resolve(__dirname, '..', 'dist');

// Server lokal menyajikan hasil build yang sama dengan output directory Vercel.
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(publishRoot, 'index.html')));
app.use('/assets', express.static(path.join(publishRoot, 'assets')));
app.use('/pages', express.static(path.join(publishRoot, 'pages')));

const server = app.listen(port, () => console.info(`Server lokal berjalan di port ${port}`));

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} sedang dipakai aplikasi lain. Hentikan Live Server atau proses lain yang memakai port tersebut, lalu jalankan npm start kembali.`);
  } else {
    console.error('Server lokal tidak dapat dijalankan:', error.message);
  }
  process.exit(1);
});
