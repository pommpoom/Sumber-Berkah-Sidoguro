const pages = [
  "dashboard", "settings", "references", "products", "suppliers", "customers", "incoming",
  "cashier", "transactions", "print", "stocktake", "password", "help"
];

async function loadPages() {
  const container = document.querySelector("#pageContainer");

  try {
    const fragments = await Promise.all(
      pages.map(async page => {
        const response = await fetch(`pages/${page}.html`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Gagal memuat halaman ${page}`);
        return response.text();
      })
    );

    container.innerHTML = fragments.join("\n");
    await loadScript("assets/js/seed-data.js?v=20260717-1");
    await loadScript("assets/js/realtime.js?v=20260717-1");
    await loadScript("assets/js/app.js?v=20260717-38");
  } catch (error) {
    document.body.classList.remove("session-checking");
    container.innerHTML = `
      <div class="load-error">
        <h2>Aplikasi tidak dapat dimuat</h2>
        <p>${error.message}</p>
        <p>Jalankan aplikasi melalui server lokal sesuai petunjuk di README.txt.</p>
      </div>`;
    console.error(error);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Gagal memuat ${src}`));
    document.body.appendChild(script);
  });
}

loadPages();
