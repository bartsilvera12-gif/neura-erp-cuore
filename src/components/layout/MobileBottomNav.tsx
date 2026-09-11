"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Home, ShoppingCart, Users, Utensils, Menu, LayoutGrid, ClipboardList, Package } from "lucide-react";
import { useBoot } from "@/components/BootContext";
import { getCurrentUser } from "@/lib/auth";

/**
 * Barra de navegación inferior — solo visible en mobile (md:hidden).
 *
 * Patrón estándar de apps mobile (Instagram, WhatsApp, etc.): los 4-5 destinos
 * más usados accesibles a 1 tap desde cualquier pantalla. El botón "Más" abre
 * el sidebar drawer existente con todos los módulos.
 *
 * Los ítems se adaptan al rol del usuario:
 *  - mozo: Mesas, Comandas, Pedidos para llevar (los 3 módulos que usa un día).
 *  - resto: Caja, Pedidos, Clientes (default original).
 */

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  matchPrefixes?: string[]; // si la ruta empieza con cualquiera, marcamos activo
};

const ITEMS_DEFAULT: NavItem[] = [
  { href: "/", label: "Inicio", icon: Home, matchPrefixes: ["/"] },
  { href: "/ventas", label: "Caja", icon: ShoppingCart, matchPrefixes: ["/ventas"] },
  { href: "/dashboard/proyectos", label: "Pedidos", icon: Utensils, matchPrefixes: ["/dashboard/proyectos"] },
  { href: "/clientes", label: "Clientes", icon: Users, matchPrefixes: ["/clientes", "/gestion-clientes"] },
];

const ITEMS_MOZO: NavItem[] = [
  { href: "/", label: "Inicio", icon: Home, matchPrefixes: ["/"] },
  { href: "/mesas", label: "Mesas", icon: LayoutGrid, matchPrefixes: ["/mesas"] },
  { href: "/comandas", label: "Comandas", icon: ClipboardList, matchPrefixes: ["/comandas"] },
  { href: "/pedidos-para-llevar", label: "Para llevar", icon: Package, matchPrefixes: ["/pedidos-para-llevar"] },
];

function isActive(pathname: string | null, item: NavItem): boolean {
  if (!pathname) return false;
  // Caso especial Inicio "/" — solo activo si pathname es exactamente "/" (sin esto matchea todo).
  if (item.href === "/") return pathname === "/";
  if (!item.matchPrefixes) return pathname === item.href;
  return item.matchPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function MobileBottomNav() {
  const pathname = usePathname();
  const { setMobileSidebarOpen } = useBoot();
  const [items, setItems] = useState<NavItem[]>(ITEMS_DEFAULT);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cu = await getCurrentUser();
        if (cancelled) return;
        const rol = (cu?.rol ?? "").trim().toLowerCase();
        setItems(rol === "mozo" ? ITEMS_MOZO : ITEMS_DEFAULT);
      } catch {
        // Sin sesión / error → dejamos el default.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <nav
      // Fijo en la parte inferior, full-width, solo mobile.
      // z-40 para quedar arriba del contenido pero por debajo de modales (z-100+).
      className="fixed bottom-0 inset-x-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_8px_rgba(0,0,0,0.04)] backdrop-blur-sm lg:hidden"
      aria-label="Navegación principal mobile"
    >
      <div className="mx-auto grid max-w-3xl grid-cols-5">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors active:bg-slate-100 sm:min-h-[64px] sm:text-[11px] ${
                active ? "text-[#4FAEB2]" : "text-slate-500 hover:text-slate-800"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className={`h-5 w-5 ${active ? "text-[#4FAEB2]" : "text-slate-500"}`} aria-hidden />
              <span className="leading-none">{item.label}</span>
            </Link>
          );
        })}
        {/* Botón "Más" — abre el sidebar drawer con todos los módulos */}
        <button
          type="button"
          onClick={() => setMobileSidebarOpen(true)}
          className="flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-slate-500 transition-colors hover:text-slate-800 active:bg-slate-100 sm:min-h-[64px] sm:text-[11px]"
          aria-label="Abrir menú completo"
        >
          <Menu className="h-5 w-5 text-slate-500" aria-hidden />
          <span className="leading-none">Más</span>
        </button>
      </div>
    </nav>
  );
}
