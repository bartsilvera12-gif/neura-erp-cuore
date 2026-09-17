"use client";

import { confirmar } from "@/components/ui/ConfirmDialog";
import { AlertTriangle, ChefHat, Pencil, Plus, Trash2 } from "lucide-react";
import SelectField from "@/components/ui/SelectField";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getProductos } from "@/lib/inventario/storage";
import type { Producto, MetodoValuacion } from "@/lib/inventario/types";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import ImportExcelButton from "@/components/ui/ImportExcelButton";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import {
  avisoError, btnIcono, btnIconoPeligro, btnPrimario, card, cardHead,
  celdaVacia, input, tabla, tbody, th, thRow, thead, tr,
} from "@/lib/ui/estilos";
import { useIsAdmin } from "@/lib/auth/use-is-admin";

const inputFilterClass =
  "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none";

const metodoBadge: Record<MetodoValuacion, string> = {
  CPP: "bg-blue-100 text-blue-700",
  FIFO: "bg-green-100 text-green-700",
  LIFO: "bg-purple-100 text-purple-700",
};

function formatGs(valor: number) {
  return `Gs. ${valor.toLocaleString("es-PY")}`;
}

function foldText(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function calcularMargenVenta(costo: number, precio: number): number {
  if (precio === 0) return 0;
  return ((precio - costo) / precio) * 100;
}

function margenColor(margen: number): string {
  if (margen >= 40) return "text-green-600";
  if (margen >= 20) return "text-yellow-600";
  return "text-red-600";
}

interface UbicacionMin { id: string; nombre: string; tipo: string }

export default function InventarioPage() {
  const { isAdmin } = useIsAdmin();
  const [todos, setTodos] = useState<Producto[]>([]);
  const [ubicaciones, setUbicaciones] = useState<UbicacionMin[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filtros por columna
  const [filtroPorNombre,  setFiltroPorNombre]  = useState("");
  const [filtroPorSku,     setFiltroPorSku]     = useState("");
  const [filtroPorCosto,   setFiltroPorCosto]   = useState("");
  const [filtroPorPrecio,  setFiltroPorPrecio]  = useState("");
  const [filtroValuacion,  setFiltroValuacion]  = useState<MetodoValuacion | "">("");
  const [filtroUbicacion,  setFiltroUbicacion]  = useState<string>(""); // "", "__sin__" o id
  const [filtroTipo,       setFiltroTipo]       = useState<"todos" | "vendibles" | "insumos" | "mixtos">("todos");
  const [tab,              setTab]               = useState<"reventa" | "menu" | "materia">("reventa");
  const [cargandoLista,    setCargandoLista]     = useState(true);
  const [soloStockBajo,    setSoloStockBajo]    = useState(false);
  const [eliminandoId,     setEliminandoId]      = useState<string | null>(null);
  const [errorAccion,      setErrorAccion]       = useState<string | null>(null);
  // Paginación: cuántas filas mostrar por vez. "todo" desactiva el corte y
  // muestra la lista entera; útil para exportar o buscar sin miedo a que se
  // pierda algo al final.
  const [filasPorPagina,   setFilasPorPagina]    = useState<25 | 50 | 100 | "todo">(25);

  /**
   * Borra el producto. Si ya circuló (ventas, movimientos, compras, recetas…)
   * el borrado rompería esos documentos, así que la API responde 409 y acá se
   * ofrece darlo de baja: deja de aparecer para operar, pero el historial
   * sigue entero.
   */
  /**
   * Enciende o apaga el control de stock del producto.
   *
   * No es un detalle menor: define todo el circuito. Un producto que lleva
   * stock se compra o se produce y al venderlo se descuenta él mismo; uno que no
   * lo lleva se arma al momento y descuenta los insumos de su receta cuando la
   * comanda entra a cocina.
   *
   * En los vendibles además decide en qué pestaña vive (Reventa lleva stock,
   * Menú no), así que se avisa antes de moverlo de lugar.
   */
  /**
   * Cambia el sector de producción del producto.
   *
   * No es cosmético: la pizzería recibe copia completa de la comanda, la plancha
   * solo sus ítems, y "ninguno" no imprime nada. Además, el armador de pizza
   * mitad y mitad solo ofrece productos del sector pizzería — una pizza cargada
   * como "ninguno" no aparece ahí, y desde la lista no había forma de notarlo.
   */
  async function cambiarSector(p: Producto, sector: string) {
    setErrorAccion(null);
    try {
      const res = await fetch(`/api/productos/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sector_produccion: sector }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setErrorAccion(body?.error ?? "No se pudo cambiar el sector.");
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setErrorAccion(e instanceof Error ? e.message : "Error de red");
    }
  }

  async function toggleControlaStock(p: Producto) {
    const controla = p.controla_stock !== false;
    const destino = !controla;
    const esVendible = p.es_vendible !== false;
    const esInsumo = p.es_insumo === true;

    const explicacion = destino
      ? `"${p.nombre}" va a llevar stock: se carga por compra o producción y al venderlo se descuenta él mismo.`
      : `"${p.nombre}" deja de llevar stock: se va a poder vender sin límite, y si tiene receta sus insumos se descontarán cuando la comanda entre a cocina.`;

    // Para un vendible, el control de stock ES la diferencia entre las
    // pestañas, así que el producto se muda al cambiarlo. Decirlo evita que
    // parezca que se borró.
    const mudanza =
      esVendible && !esInsumo
        ? `\n\nAdemás pasa a la pestaña ${destino ? "Reventa" : "Menú"}, y deja de verse en esta.`
        : "";

    if (!(await confirmar(explicacion + mudanza, {
      confirmLabel: destino ? "Activar control" : "Quitar control",
      destructivo: false,
    }))) return;

    setErrorAccion(null);
    try {
      const res = await fetch(`/api/productos/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ controla_stock: destino }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        setErrorAccion(body?.error ?? "No se pudo cambiar el control de stock.");
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setErrorAccion(e instanceof Error ? e.message : "Error de red");
    }
  }

  async function eliminarProducto(p: Producto) {
    if (eliminandoId) return;
    if (!(await confirmar(`¿Eliminar "${p.nombre}"?`, { confirmLabel: "Eliminar" }))) return;

    setEliminandoId(p.id);
    setErrorAccion(null);
    try {
      const res = await fetch(`/api/productos/${p.id}`, { method: "DELETE", credentials: "include" });
      const json = await res.json().catch(() => null);

      if (res.ok && json?.success) {
        setRefreshKey((k) => k + 1);
        return;
      }

      if (res.status === 409 && json?.puede_desactivar) {
        const baja = await confirmar(
          `${json.error} ¿Querés darlo de baja en su lugar? Deja de aparecer para operar y el historial se mantiene.`,
          { confirmLabel: "Dar de baja", destructivo: false }
        );
        if (!baja) return;
        const res2 = await fetch(`/api/productos/${p.id}?desactivar=1`, {
          method: "DELETE",
          credentials: "include",
        });
        const json2 = await res2.json().catch(() => null);
        if (!res2.ok || !json2?.success) {
          setErrorAccion(json2?.error ?? "No se pudo dar de baja el producto.");
          return;
        }
        setRefreshKey((k) => k + 1);
        return;
      }

      setErrorAccion(json?.error ?? "No se pudo eliminar el producto.");
    } catch (e) {
      setErrorAccion(e instanceof Error ? e.message : "Error de red.");
    } finally {
      setEliminandoId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setCargandoLista(true);
    getProductos()
      .then((data) => {
        if (!cancelled) setTodos(data);
      })
      .finally(() => {
        if (!cancelled) setCargandoLista(false);
      });
    // Ubicaciones para el filtro
    fetch("/api/inventario/ubicaciones", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.success) return;
        setUbicaciones((j.data?.ubicaciones ?? []) as UbicacionMin[]);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Map se reconstruia en cada render del componente (cualquier setState de
  // filtro): O(N) basura por keystroke. useMemo lo cachea hasta que cambia ubicaciones.
  const ubicacionById = useMemo(
    () => new Map(ubicaciones.map((u) => [u.id, u])),
    [ubicaciones],
  );

  // Lista filtrada: el filter recorre `todos` en cada keystroke de los filtros.
  // Con catalogos de 500-5000 productos esto era visible (lag al tipear).
  // useMemo solo recalcula cuando cambian las dependencias relevantes.
  const productos = useMemo(() => todos.filter((p) => {
    // Nombre — fold accents/diacritics ("atun" matchea "ATÚN")
    if (filtroPorNombre.trim() !== "" &&
        !foldText(p.nombre).includes(foldText(filtroPorNombre.trim())))
      return false;

    // SKU
    if (filtroPorSku.trim() !== "" &&
        !foldText(p.sku).includes(foldText(filtroPorSku.trim())))
      return false;

    // Costo promedio — acepta "35000" o "35.000"
    if (filtroPorCosto.trim() !== "") {
      const t = filtroPorCosto.trim();
      const coincide =
        String(p.costo_promedio).includes(t) ||
        p.costo_promedio.toLocaleString("es-PY").includes(t);
      if (!coincide) return false;
    }

    // Precio venta — acepta "75000" o "75.000"
    if (filtroPorPrecio.trim() !== "") {
      const t = filtroPorPrecio.trim();
      const coincide =
        String(p.precio_venta).includes(t) ||
        p.precio_venta.toLocaleString("es-PY").includes(t);
      if (!coincide) return false;
    }

    // Valuación
    if (filtroValuacion !== "" && p.metodo_valuacion !== filtroValuacion) return false;

    // Ubicación
    if (filtroUbicacion === "__sin__") {
      if (p.ubicacion_principal_id) return false;
    } else if (filtroUbicacion !== "") {
      if (p.ubicacion_principal_id !== filtroUbicacion) return false;
    }

    // Solo stock bajo
    if (soloStockBajo && p.stock_actual > p.stock_minimo) return false;

    // Tipo gastronómico (vendible/insumo/mixto)
    if (filtroTipo !== "todos") {
      const v = p.es_vendible !== false; // default true si null/undef
      const i = p.es_insumo === true;
      if (filtroTipo === "mixtos" && !(v && i)) return false;
      if (filtroTipo === "vendibles" && !(v && !i)) return false;
      if (filtroTipo === "insumos" && !(i && !v)) return false;
    }

    // Filtro por tab (Reventa | Menú | Materia prima)
    const esVendible    = p.es_vendible !== false;
    const esInsumo      = p.es_insumo === true;
    const controlaStock = p.controla_stock !== false; // default true
    if (tab === "reventa") {
      // vendibles que mueven stock real (gaseosas, postres comprados, etc.)
      if (!esVendible || !controlaStock || esInsumo) return false;
    } else if (tab === "menu") {
      // productos preparados (pizzas, lomitos, combos): vendibles SIN stock
      if (!esVendible || controlaStock || esInsumo) return false;
    } else {
      // materia prima / insumos
      if (!esInsumo) return false;
    }

    return true;
  }), [
    todos,
    filtroPorNombre,
    filtroPorSku,
    filtroPorCosto,
    filtroPorPrecio,
    filtroValuacion,
    filtroUbicacion,
    soloStockBajo,
    filtroTipo,
    tab,
  ]);

  // Recorte por paginación: si es "todo" no corta nada, sino trunca al N elegido.
  const productosVisibles = useMemo(
    () => (filasPorPagina === "todo" ? productos : productos.slice(0, filasPorPagina)),
    [productos, filasPorPagina],
  );

  const hayFiltrosActivos =
    filtroPorNombre || filtroPorSku || filtroPorCosto ||
    filtroPorPrecio || filtroValuacion || filtroUbicacion || soloStockBajo ||
    filtroTipo !== "todos";

  function limpiarFiltros() {
    setFiltroPorNombre("");
    setFiltroPorSku("");
    setFiltroPorCosto("");
    setFiltroPorPrecio("");
    setFiltroValuacion("");
    setFiltroUbicacion("");
    setSoloStockBajo(false);
    setFiltroTipo("todos");
  }

  return (
    <div className="space-y-8">

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Inventario</h1>
          <p className="mt-1 text-sm text-slate-500">Gestión de productos y control de stock.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportExcelButton url="/api/inventario/productos/export" />
          <ImportExcelButton
            entidad="Productos"
            previewUrl="/api/inventario/productos/import/preview"
            commitUrl="/api/inventario/productos/import/commit"
            templateUrl="/api/inventario/productos/import/template"
            permiteCrearFaltantes
            visible={isAdmin}
            onCompleted={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      </div>

      {/* Tabs gastronómicos (filtran por tipo de producto) */}
      <div>
        <nav
          className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm"
          aria-label="Tipo de producto"
        >
          {([
            { id: "reventa", label: "Reventa", subtitle: "Productos comprados y revendidos" },
            { id: "menu",    label: "Menú",    subtitle: "Productos preparados por el local" },
            { id: "materia", label: "Materia prima", subtitle: "Insumos para costeo/recetas" },
          ] as const).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                tab === t.id
                  ? "bg-[#4FAEB2] text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              }`}
              title={t.subtitle}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className={card}>

        <div className={cardHead}>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Productos</h2>
            </div>
            <input
              type="text"
              placeholder="Buscar por nombre…"
              value={filtroPorNombre}
              onChange={(e) => setFiltroPorNombre(e.target.value)}
              className={`${input} min-w-0 flex-1 sm:max-w-xs`}
            />

            {/* Filas por página: dropdown compacto para elegir cuántos
                productos ver a la vez. Útil cuando el catálogo crece. */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Filas</label>
              <select
                value={String(filasPorPagina)}
                onChange={(e) => {
                  const v = e.target.value;
                  setFilasPorPagina(v === "todo" ? "todo" : (Number(v) as 25 | 50 | 100));
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium text-slate-700 outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
              >
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="todo">Todo</option>
              </select>
              <span className="text-xs text-slate-500">
                {filasPorPagina === "todo" || productosVisibles.length >= productos.length
                  ? `${productos.length} de ${productos.length}`
                  : `${productosVisibles.length} de ${productos.length}`} productos
              </span>
            </div>
          </div>
          <Link href="/inventario/nuevo" className={btnPrimario}>
            <Plus className="h-4 w-4" aria-hidden />
            Nuevo producto
          </Link>
        </div>

        {/* Filtros por columna — fila 1 (SKU/Costo/Precio) oculta para UX simplificada */}
        <div className="hidden space-y-3 mb-5 pb-5 border-b border-gray-100">

          {/* Fila 1: filtros de texto por columna */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Nombre</label>
              <input
                type="text"
                placeholder="Buscar nombre..."
                value={filtroPorNombre}
                onChange={(e) => setFiltroPorNombre(e.target.value)}
                className={inputFilterClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">SKU</label>
              <input
                type="text"
                placeholder="Buscar SKU..."
                value={filtroPorSku}
                onChange={(e) => setFiltroPorSku(e.target.value)}
                className={inputFilterClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Costo promedio</label>
              <input
                type="text"
                placeholder="Ej: 35000"
                value={filtroPorCosto}
                onChange={(e) => setFiltroPorCosto(e.target.value)}
                className={inputFilterClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Precio venta</label>
              <input
                type="text"
                placeholder="Ej: 75000"
                value={filtroPorPrecio}
                onChange={(e) => setFiltroPorPrecio(e.target.value)}
                className={inputFilterClass}
              />
            </div>
          </div>

          {/* Fila 2: valuación, ubicación, stock bajo, limpiar y contador
              Ocultada para instancia Cucina del Cuore — la lógica de filtros sigue activa pero sin UI. */}
          <div className="hidden flex-wrap items-center gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Valuación</label>
              <SelectField
                value={filtroValuacion}
                onChange={(e) => setFiltroValuacion(e.target.value as MetodoValuacion | "")}
                className={inputFilterClass}
              >
                <option value="">Todos los métodos</option>
                <option value="CPP">CPP</option>
                <option value="FIFO">FIFO</option>
                <option value="LIFO">LIFO</option>
              </SelectField>
            </div>
            <div className="min-w-[14rem]">
              <label className="block text-xs text-gray-400 mb-1">Depósito / Ubicación</label>
              <SelectField
                value={filtroUbicacion}
                onChange={(e) => setFiltroUbicacion(e.target.value)}
                className={`${inputFilterClass} w-full`}
              >
                <option value="">Todas las ubicaciones</option>
                <option value="__sin__">Sin ubicación asignada</option>
                {ubicaciones.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre} — {u.tipo}
                  </option>
                ))}
              </SelectField>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none mt-4">
              <input
                type="checkbox"
                checked={soloStockBajo}
                onChange={(e) => setSoloStockBajo(e.target.checked)}
                className="rounded"
              />
              Solo stock bajo
            </label>
            <div className="mt-4 flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 p-0.5">
              {(["todos","vendibles","insumos","mixtos"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setFiltroTipo(opt)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition ${
                    filtroTipo === opt
                      ? "bg-white text-[#3F8E91] shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {opt === "todos" ? "Todos" : opt[0].toUpperCase() + opt.slice(1)}
                </button>
              ))}
            </div>
            {hayFiltrosActivos && (
              <button
                onClick={limpiarFiltros}
                className="mt-4 text-sm text-gray-400 hover:text-gray-600 transition-colors px-2"
              >
                Limpiar filtros
              </button>
            )}
            <span className="ml-auto text-sm text-gray-400 self-end mb-0.5">
              {productos.length} de {todos.length} productos
            </span>
          </div>

        </div>

        {errorAccion && (
          <div className={`${avisoError} m-5 mb-0 flex items-start gap-2`}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{errorAccion}</span>
          </div>
        )}
        <EdgeScrollArea>
          {/* min-w-[1100px] fuerza scroll horizontal real en mobile; en >=lg
              vuelve a comportarse natural. Columnas no críticas (SKU, Unidad,
              Ubicacion, Valuacion, Margen) se ocultan progresivamente. */}
          <table className={`${tabla} min-w-[840px] lg:min-w-0`}>

            <thead className={thead}>
              <tr className={thRow}>
                <th className={th}>Nombre</th>
                <th className={`${th} hidden lg:table-cell`}>SKU</th>
                <th className={`${th} text-right`}>Costo prom.</th>
                <th className={`${th} text-right`}>Precio venta</th>
                <th className={`${th} text-center`}>Stock</th>
                <th className={`${th} text-center ${tab === "reventa" ? "hidden lg:table-cell" : "hidden"}`}>Stock mín.</th>
                <th className={`${th} hidden lg:table-cell`}>Unidad</th>
                <th className={`${th} ${tab === "menu" ? "" : "hidden"}`}>Sector</th>
                <th className={`${th} hidden text-right lg:table-cell`}>
                  <span title="(precio - costo) / precio × 100">Margen s/venta</span>
                </th>
                <th className={`${th} w-32 text-right`}>Acciones</th>
              </tr>
            </thead>

            <tbody className={tbody}>
              {productos.length === 0 ? (
                <tr>
                  <td colSpan={10} className={celdaVacia}>
                    {todos.length === 0
                      ? "Todavía no cargaste productos."
                      : "Ningún producto coincide con los filtros."}
                  </td>
                </tr>
              ) : null}
              {productosVisibles.map((p) => {
                const stockBajo = p.stock_actual <= p.stock_minimo;
                const margen = calcularMargenVenta(p.costo_promedio, p.precio_venta);
                return (
                  <tr key={p.id} className={tr}>
                    <td className="px-5 py-3.5 font-medium text-slate-800">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{p.nombre}</span>
                        {(() => {
                          const v = p.es_vendible !== false;
                          const i = p.es_insumo === true;
                          // Mixto/Insumo se siguen mostrando; Vendible queda oculto (redundante: ya hay tab).
                          if (v && i) return <span className="inline-flex items-center rounded-full bg-purple-100 text-purple-700 text-[10px] font-medium px-2 py-0.5">Mixto</span>;
                          if (i) return <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-medium px-2 py-0.5">Insumo</span>;
                          return null;
                        })()}
                      </div>
                    </td>
                    <td className="hidden px-5 py-3.5 font-mono text-xs text-slate-500 lg:table-cell">{p.sku}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-slate-700">{formatGs(p.costo_promedio)}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-slate-700">{formatGs(p.precio_venta)}</td>
                    {/* El modo de stock estaba invisible fuera de Reventa, que es
                        justo donde importa: en Materia prima decide si el insumo
                        baja al cocinar. Ahora la celda lo dice y deja cambiarlo. */}
                    <td className="px-5 py-3.5 text-center">
                      {tab === "reventa" ? (
                        <span
                          className={`text-sm font-semibold tabular-nums ${stockBajo ? "text-red-600" : "text-slate-800"}`}
                          title="Los productos de reventa siempre llevan stock: se compran y se descuentan al venderse."
                        >
                          {p.stock_actual}
                        </span>
                      ) : (
                      <button
                        type="button"
                        onClick={() => toggleControlaStock(p)}
                        role="switch"
                        aria-checked={p.controla_stock !== false}
                        title={
                          p.controla_stock === false
                            ? "No lleva stock. Tocá para empezar a controlarlo."
                            : "Lleva stock. Tocá para dejar de controlarlo."
                        }
                        className="inline-flex items-center gap-2"
                      >
                        <span
                          aria-hidden
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                            p.controla_stock === false ? "bg-slate-200" : "bg-[#4FAEB2]"
                          }`}
                        >
                          <span
                            className={`absolute h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              p.controla_stock === false ? "translate-x-0.5" : "translate-x-[18px]"
                            }`}
                          />
                        </span>
                        {p.controla_stock === false ? (
                          <span className="text-[11px] font-medium text-slate-400">Sin stock</span>
                        ) : (
                          <span className={`text-sm font-semibold tabular-nums ${stockBajo ? "text-red-600" : "text-slate-800"}`}>
                            {p.stock_actual}
                          </span>
                        )}
                      </button>
                      )}
                    </td>
                    <td className={`px-5 py-3.5 text-center tabular-nums text-slate-500 ${tab === "reventa" ? "hidden lg:table-cell" : "hidden"}`}>{p.stock_minimo}</td>
                    <td className="hidden px-5 py-3.5 text-slate-600 lg:table-cell">{p.unidad_medida}</td>
                    <td className={`px-5 py-3.5 ${tab === "menu" ? "" : "hidden"}`}>
                      <select
                        value={p.sector_produccion ?? "ninguno"}
                        onChange={(e) => cambiarSector(p, e.target.value)}
                        aria-label={`Sector de producción de ${p.nombre}`}
                        title="Pizzería recibe copia completa de la comanda; plancha solo sus ítems; ninguno no imprime."
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-600 outline-none transition-colors hover:border-[#4FAEB2]/50 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
                      >
                        <option value="ninguno">Ninguno</option>
                        <option value="pizzeria">Pizzería</option>
                        <option value="plancha">Plancha</option>
                      </select>
                    </td>
                    <td className={`hidden px-5 py-3.5 text-right font-semibold tabular-nums lg:table-cell ${margenColor(margen)}`}>
                      {margen.toFixed(2)}%
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Receta: solo para lo que el local prepara. Un producto de
                            reventa no tiene nada que costear ni que descontar. */}
                        {p.es_vendible !== false && p.controla_stock === false && (
                          <Link
                            href={`/dashboard/recetas/nueva?producto=${p.id}`}
                            className={btnIcono}
                            aria-label={`Receta de ${p.nombre}`}
                            title="Ver o crear la receta"
                          >
                            <ChefHat className="h-4 w-4" aria-hidden />
                          </Link>
                        )}
                        <Link
                          href={`/inventario/${p.id}/editar`}
                          className={btnIcono}
                          aria-label={`Editar ${p.nombre}`}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Link>
                        <button
                          type="button"
                          onClick={() => eliminarProducto(p)}
                          disabled={eliminandoId === p.id}
                          title={`Eliminar ${p.nombre}`}
                          aria-label={`Eliminar ${p.nombre}`}
                          className={btnIconoPeligro}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>

          </table>
        </EdgeScrollArea>

      </div>

    </div>
  );
}
