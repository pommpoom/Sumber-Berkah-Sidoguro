import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  CircleHelp,
  ClipboardCheck,
  History,
  LayoutDashboard,
  KeyRound,
  LogOut,
  Package,
  PackagePlus,
  Printer,
  Settings,
  ShoppingCart,
  Truck,
  Users,
} from "lucide-react";

const menuItems = [
  { name: "Dashboard", path: "dashboard", icon: LayoutDashboard },
  { name: "Transaksi Kasir", path: "cashier", icon: ShoppingCart },
  { name: "Riwayat Transaksi", path: "transactions", icon: History },
  { name: "Cetak Nota", path: "print", icon: Printer },
  { name: "Produk", path: "products", icon: Package },
  { name: "Supplier", path: "suppliers", icon: Truck },
  { name: "Pelanggan", path: "customers", icon: Users },
  { name: "Referensi", path: "references", icon: BookOpen },
  { name: "Barang Masuk", path: "incoming", icon: PackagePlus },
  { name: "Stok Opname", path: "stocktake", icon: ClipboardCheck },
  { name: "Pengaturan", path: "settings", icon: Settings },
  { name: "Ganti Password", path: "password", icon: KeyRound },
  { name: "Bantuan", path: "help", icon: CircleHelp },
  { name: "Log out", path: null, icon: LogOut, id: "logoutBtn" },
];

function SidebarMenu() {
  useEffect(() => {
    const handleKeyboardNavigation = event => {
      const buttons = [...navigation.querySelectorAll("button")];
      const currentIndex = buttons.indexOf(document.activeElement);
      if (currentIndex < 0 || !["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;

      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % buttons.length;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = buttons.length - 1;

      buttons[nextIndex].focus({ preventScroll: true });
      buttons[nextIndex].scrollIntoView({ block: "nearest" });
    };

    navigation.addEventListener("keydown", handleKeyboardNavigation);
    return () => navigation.removeEventListener("keydown", handleKeyboardNavigation);
  }, []);

  return menuItems.map(({ name, path, icon: Icon, id }) => (
    <button key={name} id={id} data-page={path || undefined} type="button">
      <Icon className="menu-icon" size={21} aria-hidden="true" />
      <span>{name}</span>
    </button>
  ));
}

const navigation = document.querySelector("#topNav");

if (navigation) {
  createRoot(navigation).render(<SidebarMenu />);
}
