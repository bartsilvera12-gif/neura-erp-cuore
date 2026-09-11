"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, BarChart3, Building2, ChefHat, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, History, LayoutDashboard, LayoutGrid, ListChecks, Megaphone, MessageCircle, Package, Receipt, ScrollText, Search, SendHorizontal, ShoppingCart, Sparkles, Star, Ticket, UserCog, Users, Utensils } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getCurrentUser } from "@/lib/auth";
import { isBootstrapSuperAdminEmail } from "@/lib/auth/super-admin-bootstrap-email";
import { supabase } from "@/lib/supabase";
import type { ModuloEmpresa } from "@/lib/empresas/actions";
import { getFavoritos, toggleFavorito } from "@/lib/favorites";
import { canAccessSidebarSlug } from "@/lib/modulos/route-slug-map";
import { useBoot } from "@/components/BootContext";
import { getModuleAccessCached, peekModuleAccessCache } from "@/lib/modulos/module-access-cache";

type MenuItem = {
  key: string;
  slug: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: { label: string; href: string; exactMatch?: boolean }[];
  showWhen?: string;
};

function menuChildPathActive(path: string, childHref: string, exactMatch?: boolean): boolean {
  if (path === childHref) return true;
  if (exactMatch) return false;
  return path.startsWith(`${childHref}/`);
}

/** Normaliza texto para búsqueda en el menú (sin acentos, minúsculas). */
function normalizeMenuSearch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function menuItemMatchesQuery(item: MenuItem, queryRaw: string): boolean {
  const q = normalizeMenuSearch(queryRaw);
  if (!q) return true;
  if (normalizeMenuSearch(item.label).includes(q)) return true;
  return item.children?.some((c) => normalizeMenuSearch(c.label).includes(q)) ?? false;
}

function adminEmpresasMatchesQuery(queryRaw: string): boolean {
  const q = normalizeMenuSearch(queryRaw);
  if (!q) return true;
  const label = normalizeMenuSearch("Admin Empresas");
  return label.includes(q) || normalizeMenuSearch("empresas").includes(q);
}

const MENU_STRUCTURE: MenuItem[] = [
  { key: "dashboard", slug: "dashboard", label: "Dashboard", href: "/", icon: LayoutDashboard },
  {
    key: "conversaciones",
    slug: "conversaciones",
    label: "Conversaciones",
    href: "/dashboard/conversaciones",
    icon: MessageCircle,
  },
  {
    key: "historial-omnicanal",
    slug: "historial-omnicanal",
    label: "Historial omnicanal",
    href: "/dashboard/historial-omnicanal",
    icon: History,
  },
  {
    key: "conversaciones-finalizadas",
    slug: "conversaciones-finalizadas",
    label: "Finalizadas",
    href: "/dashboard/conversaciones-finalizadas",
    icon: ListChecks,
  },
  {
    key: "monitoreo",
    slug: "monitoreo",
    label: "Monitoreo",
    href: "/dashboard/monitoreo",
    icon: Activity,
  },
  { key: "mesas", slug: "mesas", label: "Mesas", href: "/mesas", icon: LayoutGrid },
  { key: "comandas", slug: "comandas", label: "Comandas", href: "/comandas", icon: ClipboardList },
  { key: "pedidos-para-llevar", slug: "comandas", label: "Pedidos para llevar", href: "/pedidos-para-llevar", icon: ClipboardList },
  { key: "ventas", slug: "ventas", label: "Caja", href: "/ventas", icon: ShoppingCart },
  { key: "reportes", slug: "reportes", label: "Reportes", href: "/reportes", icon: BarChart3, children: [
    { label: "Compras", href: "/reportes/compras" },
    { label: "Cierres de caja", href: "/reportes/cierres-caja" },
    { label: "Conciliación bancaria", href: "/reportes/conciliacion-bancaria" },
  ] },
  {
    key: "proyectos",
    slug: "proyectos",
    label: "Pedidos",
    href: "/dashboard/proyectos",
    icon: Utensils,
  },
  { key: "recetas", slug: "recetas", label: "Recetas", href: "/dashboard/recetas", icon: ChefHat },
  { key: "inventario", slug: "inventario", label: "Inventario", href: "/inventario", icon: Package, children: [
    { label: "Productos", href: "/inventario" },
    { label: "Movimientos", href: "/inventario/movimientos" },
    { label: "Categorías", href: "/inventario/categorias" },
    // "Depósitos / Ubicaciones" oculto en instancia Cucina del Cuore (no aplica para gastronomía).
  ]},
  { key: "clientes", slug: "clientes", label: "Clientes", href: "/clientes", icon: Users },
  {
    key: "compras",
    slug: "compras",
    label: "Compras",
    href: "/compras",
    icon: Package,
    children: [
      { label: "Órdenes", href: "/compras" },
      { label: "Proveedores", href: "/proveedores" },
    ],
  },
  { key: "gastos", slug: "gastos", label: "Gastos", href: "/gastos", icon: Receipt },
  // Pagos oculto en instancia Cucina del Cuore (no usa este módulo).
  {
    key: "notas_credito",
    slug: "notas_credito",
    label: "Notas de crédito",
    href: "/notas-credito",
    icon: ScrollText,
  },
  { key: "usuarios", slug: "usuarios", label: "Usuarios", href: "/usuarios", icon: UserCog },
  // Configuración oculta del menú a pedido del local: se toca muy de vez en
  // cuando y no tiene por qué estar a un clic de la caja.
  //
  // Sólo se saca del menú: las pantallas siguen funcionando entrando por URL
  // (/configuracion, /configuracion/facturacion-electronica, etc.). El permiso
  // lo sigue aplicando el servidor como siempre, así que esconderlo no habilita
  // ni bloquea a nadie: es nada más sacarlo de la vista.
  { key: "crm", slug: "crm", label: "CRM Funnel", href: "/crm", icon: Sparkles },
  { key: "marketing", slug: "marketing", label: "Marketing Legacy", href: "/marketing", icon: Megaphone },
  { key: "marketing_ops", slug: "marketing_ops", label: "Marketing Ops", href: "/dashboard/marketing-ops", icon: Megaphone },
  {
    key: "campanas",
    slug: "campanas",
    label: "Campañas",
    href: "/dashboard/campanas",
    icon: SendHorizontal,
  },
  {
    key: "sorteos",
    slug: "sorteos",
    label: "Sorteos",
    href: "/sorteos",
    icon: Ticket,
    children: [{ label: "Tickets / Comprobantes", href: "/sorteos/tickets", exactMatch: true }],
  },
];

/**
 * Agrupación visual del menú: header chico en mayúsculas + ítems debajo, cada
 * sección colapsable. Sólo agrupa; NO decide permisos — eso sigue saliendo de
 * `empresa_modulos`, así que una sección con todos sus ítems ocultos no se
 * dibuja.
 *
 * Los `keys` que no figuren acá caen en "Otros" (ver SECTION_FALLBACK), para que
 * agregar un ítem al menú nunca lo haga desaparecer del sidebar por olvido.
 */
const MENU_SECTIONS: { label: string; keys: string[] }[] = [
  { label: "General",     keys: ["dashboard"] },
  { label: "Omnicanal",   keys: ["conversaciones", "historial-omnicanal", "conversaciones-finalizadas", "monitoreo"] },
  { label: "Salón",       keys: ["mesas", "comandas", "pedidos-para-llevar", "proyectos"] },
  { label: "Comercial",   keys: ["ventas", "clientes", "crm"] },
  { label: "Operaciones", keys: ["inventario", "recetas", "compras", "gastos"] },
  { label: "Contable",    keys: ["reportes", "notas_credito"] },
  { label: "Marketing",   keys: ["campanas", "marketing", "marketing_ops", "sorteos"] },
  { label: "Administración", keys: ["usuarios", "planes"] },
];

const SECTION_FALLBACK = "Otros";

function modulosSyntheticFromMenu(): ModuloEmpresa[] {
  return MENU_STRUCTURE.map((item) => ({
    id: item.slug,
    nombre: item.label,
    slug: item.slug,
  }));
}

function NavItem({
  item,
  itemId,
  isActive,
  isFavorito,
  onToggleFavorito,
  hasAccess,
  collapsed,
  expanded,
  onToggleExpand,
}: {
  item: MenuItem;
  itemId: string;
  isActive: boolean;
  isFavorito: boolean;
  onToggleFavorito: (id: string) => void;
  hasAccess: boolean;
  collapsed: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const Icon = item.icon;
  const p = usePathname() ?? "";
  const router = useRouter();

  if (!hasAccess) return null;

  const childActive = item.children?.some((c) => menuChildPathActive(p, c.href, c.exactMatch));

  if (item.children) {
    const rowTone =
      isActive || childActive
        ? "bg-[color:var(--zentra-sidebar-active)] text-white shadow-[inset_3px_0_0_var(--zentra-sidebar-accent)]"
        : "text-slate-200 hover:bg-[color:var(--zentra-sidebar-hover)]";
    return (
      <div className="space-y-0.5">
        <div className={`flex items-center gap-0.5 rounded-lg text-sm font-medium transition-colors ${rowTone}`}>
          <Link
            href={item.href}
            prefetch={false}
            onMouseEnter={() => router.prefetch(item.href)}
            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5"
            title={item.label}
          >
            <Icon className={`h-5 w-5 shrink-0 ${isActive || childActive ? "text-white" : "text-slate-400"}`} />
            {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
          </Link>
          {!collapsed && (
            <>
              <button
                type="button"
                onClick={() => onToggleFavorito(itemId)}
                className={`shrink-0 rounded p-0.5 ${isFavorito ? "text-amber-300" : "text-slate-500 hover:text-amber-300"}`}
                aria-label="Favorito"
              >
                <Star className={`h-4 w-4 ${isFavorito ? "fill-current" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => onToggleExpand()}
                className="shrink-0 rounded p-1 text-current hover:opacity-90"
                aria-expanded={expanded}
                aria-label={expanded ? "Contraer submenú" : "Expandir submenú"}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            </>
          )}
        </div>
        <AnimatePresence>
          {expanded && !collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden pl-4 space-y-0.5"
            >
              {item.children.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  prefetch={false}
                  onMouseEnter={() => router.prefetch(c.href)}
                  className={`block rounded-lg px-3 py-2 text-sm transition-all ${
                    menuChildPathActive(p, c.href, c.exactMatch)
                      ? "bg-[color:var(--zentra-sidebar-active)] text-white font-medium shadow-[inset_3px_0_0_var(--zentra-sidebar-accent)]"
                      : "text-slate-300 hover:bg-[color:var(--zentra-sidebar-hover)]"
                  }`}
                >
                  {c.label}
                </Link>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      prefetch={false}
      onMouseEnter={() => router.prefetch(item.href)}
      className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
        isActive
          ? "bg-[color:var(--zentra-sidebar-active)] text-white shadow-[inset_3px_0_0_var(--zentra-sidebar-accent)]"
          : "text-slate-200 hover:bg-[color:var(--zentra-sidebar-hover)]"
      }`}
    >
      <Icon className={`h-5 w-5 shrink-0 ${isActive ? "text-white" : "text-slate-400"}`} />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); onToggleFavorito(itemId); }}
            className={`rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 ${
              isFavorito ? "opacity-100 text-amber-300" : "text-slate-500 hover:text-amber-300"
            }`}
          >
            <Star className={`h-4 w-4 ${isFavorito ? "fill-current" : ""}`} />
          </button>
        </>
      )}
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const navScrollRef = useRef<HTMLElement | null>(null);
  const navContentRef = useRef<HTMLDivElement | null>(null);
  const [scrollIndicator, setScrollIndicator] = useState({
    visible: false,
    thumbHeight: 0,
    thumbTop: 0,
  });
  // ── Hidratación SÍNCRONA desde cache (localStorage) ───────────────────────
  // Si hay cache válido del último login, arrancamos con módulos + cargando=false.
  // Esto elimina el flash "Cargando…" cuando Chrome descarta la pestaña en
  // background y la remonta al volver (tab discarding).
  // El refetch en el useEffect de abajo sigue ocurriendo en background como
  // stale-while-revalidate, pero sin ocultar el menú.
  const cachedAccess = peekModuleAccessCache();
  const [modulos, setModulos] = useState<ModuloEmpresa[]>(() =>
    Array.isArray(cachedAccess?.modulos) ? cachedAccess!.modulos! : [],
  );
  const [inactiveSlugsList, setInactiveSlugsList] = useState<string[]>(() =>
    Array.isArray(cachedAccess?.inactiveSlugs) ? cachedAccess!.inactiveSlugs! : [],
  );
  const [strictAllowlist, setStrictAllowlist] = useState<boolean>(
    !!cachedAccess?.strictAllowlist,
  );
  const [favoritos, setFavoritos] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({
    inventario: true,
    sorteos: true,
    compras: true,
  });
  // cargando arranca en false si ya hidratamos desde cache; el spinner solo
  // aparece en el primer login real, no al volver a la pestaña.
  const [cargando, setCargando] = useState<boolean>(
    !(cachedAccess && (cachedAccess.modulos?.length || cachedAccess.slugs?.length)),
  );
  const [esSuperAdmin, setEsSuperAdmin] = useState<boolean>(!!cachedAccess?.superAdmin);
  /** Filtro visual del menú (no altera permisos ni rutas). */
  const [menuSearchQuery, setMenuSearchQuery] = useState("");
  const { setSidebarReady, mobileSidebarOpen, setMobileSidebarOpen } = useBoot();

  const updateScrollIndicator = useCallback(() => {
    const el = navScrollRef.current;
    if (!el) return;

    const scrollable = el.scrollHeight > el.clientHeight + 1;
    if (!scrollable) {
      setScrollIndicator((prev) =>
        prev.visible ? { visible: false, thumbHeight: 0, thumbTop: 0 } : prev
      );
      return;
    }

    const trackHeight = Math.max(el.clientHeight - 20, 1);
    const thumbHeight = Math.max(36, (el.clientHeight / el.scrollHeight) * trackHeight);
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    const maxScrollTop = Math.max(el.scrollHeight - el.clientHeight, 1);
    const thumbTop = (el.scrollTop / maxScrollTop) * maxThumbTop;

    setScrollIndicator((prev) => {
      const next = { visible: true, thumbHeight, thumbTop };
      if (
        prev.visible === next.visible &&
        Math.abs(prev.thumbHeight - next.thumbHeight) < 0.5 &&
        Math.abs(prev.thumbTop - next.thumbTop) < 0.5
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  /** Cerrar el drawer mobile al cambiar de ruta. */
  useEffect(() => {
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  /** Reporta al BootContext cuándo el sidebar tiene sus módulos cargados.
   *  Sticky: solo va false → true, nunca true → false. Esto evita que el
   *  ZentraLoader vuelva a aparecer entre navegaciones cuando Supabase
   *  dispara onAuthStateChange (token refresh) y reinicia "cargando". */
  useEffect(() => {
    if (!cargando) {
      setSidebarReady(true);
    }
  }, [cargando, setSidebarReady]);

  useEffect(() => {
    setFavoritos(getFavoritos());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function cargarMenuDesdeSesion(
      session: Session | null,
      opts?: { forceRefresh?: boolean },
    ) {
      try {
        // Stale-while-revalidate: solo mostramos "Cargando…" si NO tenemos
        // módulos en estado. Si ya hay módulos (hidratados del cache o de un
        // fetch previo), refrescamos en background sin ocultar el menú.
        // Esto evita el flash de loader al volver a la pestaña o ante eventos
        // SIGNED_IN/USER_UPDATED de Supabase que en realidad no cambian nada.
        setCargando((prev) => (modulos.length === 0 ? true : prev));
        if (cancelled) return;
        if (!session?.user) {
          setModulos([]);
          setEsSuperAdmin(false);
          return;
        }

        const { ok, data: body } = await getModuleAccessCached({
          forceRefresh: opts?.forceRefresh,
        });
        if (cancelled) return;

        let superA = false;
        let modList: ModuloEmpresa[] = [];
        const bootstrapSuper = isBootstrapSuperAdminEmail(session.user.email ?? null);

        let inactiveList: string[] = [];
        let strict = false;
        if (ok) {
          superA = !!body.superAdmin || bootstrapSuper;
          modList = Array.isArray(body.modulos) ? body.modulos : [];
          inactiveList = Array.isArray(body.inactiveSlugs) ? body.inactiveSlugs : [];
          strict = !!body.strictAllowlist;
        } else {
          superA = bootstrapSuper;
        }

        if (!superA) {
          try {
            const cu = await getCurrentUser();
            if ((cu?.rol ?? "").trim() === "super_admin") {
              superA = true;
              const mr = await fetchWithSupabaseSession("/api/admin/modulos", { cache: "no-store" });
              if (mr.ok) {
                const raw = (await mr.json()) as { id?: string; nombre?: string; slug?: string }[];
                if (Array.isArray(raw) && raw.length > 0) {
                  modList = raw.map((m) => ({
                    id: m.id ?? "",
                    nombre: m.nombre ?? "",
                    slug: m.slug ?? "",
                  }));
                }
              }
            }
          } catch {
            /* getCurrentUser puede fallar si RLS; el servidor ya intentó */
          }
        }

        if (superA && modList.length === 0) {
          modList = modulosSyntheticFromMenu();
        }

        if (cancelled) return;
        setEsSuperAdmin(superA);
        setModulos(modList);
        setInactiveSlugsList(inactiveList);
        setStrictAllowlist(strict);
      } catch {
        if (!cancelled) {
          setModulos([]);
          setEsSuperAdmin(false);
          setInactiveSlugsList([]);
          setStrictAllowlist(false);
        }
      } finally {
        if (!cancelled) setCargando(false);
      }
    }

    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!cancelled) void cargarMenuDesdeSesion(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      // Skip eventos que NO cambian que modulos tiene el user:
      //  - INITIAL_SESSION: ya cargado por el getSession() de arriba (duplicado).
      //  - TOKEN_REFRESHED: Supabase refresca el JWT cada ~1h Y cuando la pestana
      //    vuelve a estar visible. Los modulos del user no cambian por esto;
      //    re-fetchear hace que el sidebar muestre "Cargando..." sin motivo
      //    cada vez que el usuario vuelve a la tab del ERP.
      // Eventos que SI re-cargan: SIGNED_IN, SIGNED_OUT, USER_UPDATED.
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      // SIGNED_IN puede significar usuario nuevo (sesión cambió) — forzamos
      // refresh del cache para no servir módulos del usuario anterior.
      // USER_UPDATED: cambió el JWT del mismo user (raro), también refrescamos.
      const forceRefresh = event === "SIGNED_IN" || event === "USER_UPDATED";
      void cargarMenuDesdeSesion(session, { forceRefresh });
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const handleToggleFavorito = (id: string) => {
    setFavoritos(toggleFavorito(id));
  };

  const modulosSlugs = new Set(modulos.map((m) => m.slug));
  const inactiveSlugsSet = useMemo(() => new Set(inactiveSlugsList), [inactiveSlugsList]);
  const hasAccess = (slug: string) =>
    canAccessSidebarSlug(slug, modulosSlugs, esSuperAdmin, inactiveSlugsSet, {
      strict: strictAllowlist,
    });

  const isActive = (slug: string, href: string) => {
    const p = pathname ?? "";
    if (slug === "dashboard") return p === "/";
    return p === href || p.startsWith(href + "/");
  };

  const toggleExpand = (menuKey: string) => {
    setExpandedItems((prev) => ({ ...prev, [menuKey]: !prev[menuKey] }));
  };

  /** Qué secciones quedaron colapsadas, por label. Se lee al montar y se guarda
   *  en cada cambio. Sin valor previo, todas arrancan expandidas. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("zentra:sidebar:collapsedSections");
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        if (parsed && typeof parsed === "object") setCollapsedSections(parsed);
      }
    } catch {
      /* localStorage puede fallar en modo privado; se ignora */
    }
  }, []);

  const toggleSection = (label: string) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("zentra:sidebar:collapsedSections", JSON.stringify(next));
        }
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const slugToId = (slug: string) => modulos.find((m) => m.slug === slug)?.id ?? slug;

  const favoritosItemsFiltered = useMemo(() => {
    const slugs = new Set(modulos.map((m) => m.slug));
    const idForSlug = (slug: string) => modulos.find((m) => m.slug === slug)?.id ?? slug;
    const access = (slug: string) =>
      canAccessSidebarSlug(slug, slugs, esSuperAdmin, inactiveSlugsSet, { strict: strictAllowlist });
    return MENU_STRUCTURE.filter(
      (item) =>
        favoritos.includes(idForSlug(item.slug)) &&
        access(item.slug) &&
        menuItemMatchesQuery(item, menuSearchQuery)
    );
  }, [favoritos, menuSearchQuery, modulos, esSuperAdmin, inactiveSlugsSet, strictAllowlist]);

  const mainItemsFiltered = useMemo(() => {
    const slugs = new Set(modulos.map((m) => m.slug));
    const idForSlug = (slug: string) => modulos.find((m) => m.slug === slug)?.id ?? slug;
    const access = (slug: string) =>
      canAccessSidebarSlug(slug, slugs, esSuperAdmin, inactiveSlugsSet, { strict: strictAllowlist });
    return MENU_STRUCTURE.filter(
      (item) =>
        !favoritos.includes(idForSlug(item.slug)) &&
        access(item.slug) &&
        menuItemMatchesQuery(item, menuSearchQuery)
    );
  }, [favoritos, menuSearchQuery, modulos, esSuperAdmin, inactiveSlugsSet, strictAllowlist]);

  /**
   * Reparte `mainItemsFiltered` en las secciones de MENU_SECTIONS, conservando
   * el orden declarado ahí. Las secciones que quedan sin ítems visibles no se
   * dibujan. Lo que no esté asignado a ninguna sección cae en "Otros", así
   * agregar un ítem al menú nunca lo hace desaparecer del sidebar.
   */
  const seccionesVisibles = useMemo(() => {
    const restantes = new Map(mainItemsFiltered.map((i) => [i.key, i]));
    const out: { label: string; items: MenuItem[] }[] = [];

    for (const section of MENU_SECTIONS) {
      const items: MenuItem[] = [];
      for (const k of section.keys) {
        const item = restantes.get(k);
        if (item) {
          items.push(item);
          restantes.delete(k);
        }
      }
      if (items.length > 0) out.push({ label: section.label, items });
    }

    if (restantes.size > 0) {
      out.push({ label: SECTION_FALLBACK, items: [...restantes.values()] });
    }
    return out;
  }, [mainItemsFiltered]);

  const anyMenuVisible =
    favoritosItemsFiltered.length > 0 ||
    mainItemsFiltered.length > 0 ||
    (esSuperAdmin && adminEmpresasMatchesQuery(menuSearchQuery));

  const showMenuNoResults =
    !cargando && normalizeMenuSearch(menuSearchQuery).length > 0 && !anyMenuVisible;

  useEffect(() => {
    const q = menuSearchQuery.trim();
    if (!q) return;
    const n = normalizeMenuSearch(q);
    setExpandedItems((prev) => {
      const next = { ...prev };
      for (const item of MENU_STRUCTURE) {
        if (item.children?.some((c) => normalizeMenuSearch(c.label).includes(n))) {
          next[item.key] = true;
        }
      }
      return next;
    });
  }, [menuSearchQuery]);

  useEffect(() => {
    const el = navScrollRef.current;
    if (!el) return;

    updateScrollIndicator();
    const observer = new ResizeObserver(updateScrollIndicator);
    observer.observe(el);
    if (navContentRef.current) observer.observe(navContentRef.current);
    el.addEventListener("scroll", updateScrollIndicator, { passive: true });

    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", updateScrollIndicator);
    };
  }, [updateScrollIndicator]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(updateScrollIndicator);
    return () => window.cancelAnimationFrame(raf);
  });

  return (
    <>
      {/* Backdrop mobile: cubre el contenido cuando el drawer esta abierto */}
      {mobileSidebarOpen ? (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setMobileSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-slate-900/55 backdrop-blur-sm lg:hidden"
        />
      ) : null}

      <motion.aside
        id="neura-sidebar"
        initial={false}
        animate={{ width: collapsed ? 80 : 260 }}
        transition={{ duration: 0.2 }}
        className={`zentra-sidebar-bg flex h-svh min-h-0 shrink-0 flex-col border-r border-[color:var(--zentra-sidebar-border)] lg:relative lg:z-auto lg:translate-x-0 lg:shadow-none ${
          mobileSidebarOpen
            ? "fixed inset-y-0 left-0 z-50 translate-x-0 shadow-2xl transition-transform duration-200"
            : "fixed inset-y-0 left-0 z-50 -translate-x-full lg:translate-x-0 transition-transform duration-200"
        }`}
      >
      {/* Logo oficial ZENTRA (blanco sobre azul marca).
          Colapsado se cambia por el isotipo: el wordmark no entra en 44px. */}
      <div className="flex h-[7.25rem] shrink-0 items-center justify-center border-b border-[color:var(--zentra-sidebar-border)] bg-[color:var(--zentra-sidebar-elevated)]/35 px-3 py-2.5">
        <Link href="/" className="flex min-w-0 items-center justify-center overflow-hidden">
          <div
            className={`relative flex items-center justify-center ${collapsed ? "h-11 w-11" : "h-[4.5rem] w-full max-w-[200px]"}`}
          >
            <Image
              src={collapsed ? "/brand/zentra-icon.png" : "/brand/zentra-logo-official.png"}
              alt="ZENTRA"
              width={400}
              height={220}
              sizes={collapsed ? "44px" : "200px"}
              className="h-full w-full object-contain object-center"
              priority
            />
          </div>
        </Link>
      </div>

      {/* Colapsar/expandir: círculo sobre el borde derecho, a la altura del
          buscador. Sólo en desktop — en mobile el sidebar se abre y cierra con
          el botón del header, no colapsa. */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-[8.25rem] z-20 hidden h-7 w-7 items-center justify-center rounded-full border border-[#104A4E] bg-[#104A4E] text-white shadow-md transition-colors hover:bg-[#0d3d40] lg:flex"
        aria-label={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>

      {!collapsed && (
        <div className="shrink-0 border-b border-[color:var(--zentra-sidebar-border)] px-3 py-2.5">
          <label htmlFor="sidebar-menu-search" className="sr-only">
            Buscar en el menú
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              id="sidebar-menu-search"
              type="search"
              autoComplete="off"
              placeholder="Buscar en el menú…"
              value={menuSearchQuery}
              onChange={(e) => setMenuSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-white/15 bg-white/10 py-2 pl-8 pr-2.5 text-xs text-white outline-none transition-[border-color,box-shadow] placeholder:text-slate-400 focus:border-sky-400/45 focus:ring-2 focus:ring-sky-400/35"
            />
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
      <nav
        ref={navScrollRef}
        className="zentra-sidebar-scroll h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain p-3"
      >
        <div ref={navContentRef}>
        {showMenuNoResults ? (
          <p className="px-2 py-6 text-center text-xs text-slate-400">Sin resultados</p>
        ) : null}

        {/* Favoritos */}
        {favoritosItemsFiltered.length > 0 && !collapsed && (
          <div className="mb-4">
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500"><Star className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> Favoritos</p>
            <div className="space-y-0.5">
              {favoritosItemsFiltered.map((item) => (
                <NavItem
                  key={item.key}
                  item={item}
                  itemId={slugToId(item.slug)}
                  isActive={isActive(item.slug, item.href)}
                  isFavorito={true}
                  onToggleFavorito={handleToggleFavorito}
                  hasAccess={hasAccess(item.slug)}
                  collapsed={collapsed}
                  expanded={expandedItems[item.key] ?? false}
                  onToggleExpand={() => toggleExpand(item.key)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Menú principal, agrupado en secciones colapsables */}
        {cargando && mainItemsFiltered.length === 0 ? (
          <div className="px-3 py-2 text-sm text-slate-500 animate-pulse">Cargando…</div>
        ) : (
          seccionesVisibles.map(({ label, items }) => {
            // Con el sidebar entero colapsado se ven sólo los íconos: ahí no hay
            // header ni nada que colapsar por sección.
            const seccionCerrada = !collapsed && (collapsedSections[label] ?? false);
            const tieneActivo = items.some((i) => isActive(i.slug, i.href));
            return (
              <div key={label} className="mb-3">
                {!collapsed && (
                  <button
                    type="button"
                    onClick={() => toggleSection(label)}
                    title={`${seccionCerrada ? "Expandir" : "Colapsar"} ${label}`}
                    aria-expanded={!seccionCerrada}
                    className="group mb-2 flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-[color:var(--zentra-sidebar-hover)]"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full transition-colors ${
                          tieneActivo
                            ? "bg-[color:var(--zentra-sidebar-accent)]"
                            : "bg-slate-500/60"
                        }`}
                        aria-hidden
                      />
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 group-hover:text-slate-100">
                        {label}
                      </span>
                    </span>
                    <ChevronDown
                      className={`h-5 w-5 shrink-0 text-slate-400 transition-transform group-hover:text-slate-200 ${
                        seccionCerrada ? "-rotate-90" : ""
                      }`}
                      aria-hidden
                    />
                  </button>
                )}
                {!seccionCerrada && (
                  <div className="space-y-0.5">
                    {items.map((item) => (
                      <NavItem
                        key={item.key}
                        item={item}
                        itemId={slugToId(item.slug)}
                        isActive={isActive(item.slug, item.href)}
                        isFavorito={favoritos.includes(slugToId(item.slug))}
                        onToggleFavorito={handleToggleFavorito}
                        hasAccess={hasAccess(item.slug)}
                        collapsed={collapsed}
                        expanded={expandedItems[item.key] ?? false}
                        onToggleExpand={() => toggleExpand(item.key)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* Admin */}
        {esSuperAdmin && adminEmpresasMatchesQuery(menuSearchQuery) && (
          <div className="mt-6 pt-4 border-t border-[color:var(--zentra-sidebar-border)]">
            {!collapsed && (
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Admin</p>
            )}
            <Link
              href="/admin/empresas"
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                (pathname ?? "").startsWith("/admin/empresas")
                  ? "bg-[color:var(--zentra-sidebar-active)] text-amber-100 shadow-[inset_3px_0_0_var(--zentra-sidebar-accent)]"
                  : "text-amber-300/95 hover:bg-[color:var(--zentra-sidebar-hover)]"
              }`}
            >
              <Building2 className="h-5 w-5 shrink-0" />
              {!collapsed && <span className="truncate">Admin Empresas</span>}
            </Link>
          </div>
        )}
        </div>
      </nav>

        {scrollIndicator.visible ? (
          <div className="pointer-events-none absolute inset-y-2.5 right-1.5 w-1 rounded-full bg-white/[0.035]">
            <motion.span
              className="absolute left-0 top-0 block w-full rounded-full bg-[#4FAEB2]/55 shadow-[0_0_10px_rgba(79,174,178,0.32)]"
              animate={{ height: scrollIndicator.thumbHeight, y: scrollIndicator.thumbTop }}
              transition={{ type: "spring", stiffness: 420, damping: 38, mass: 0.35 }}
            />
          </div>
        ) : null}
      </div>
      </motion.aside>
    </>
  );
}
