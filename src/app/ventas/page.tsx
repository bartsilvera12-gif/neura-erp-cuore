"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { FancySelect } from "@/components/ui/FancySelect";
import MobileFab from "@/components/ui/MobileFab";
import CajaControlPanel from "@/components/caja/CajaControlPanel";
import MesasPorCobrarCajaCard from "@/components/mesas/MesasPorCobrarCajaCard";
import { getVentas } from "@/lib/ventas/storage";
import type { Venta, TipoVenta, TipoIvaVenta } from "@/lib/ventas/types";
import { sectoresParaTicket, sectoresCocinaParaComanda } from "@/lib/ventas/sector-tickets";
import FacturarVentaModal from "@/components/ventas/FacturarVentaModal";
import { FileText } from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

/**
 * Abre una pestaña de impresión INDEPENDIENTE por copia: Cliente siempre, y
 * Pizzería / Plancha según los sectores presentes en la venta. Cada pestaña
 * auto-imprime (auto=1). Se llama desde el click del usuario (gesto válido),
 * por eso el navegador permite abrir varias pestañas a la vez.
 */
function abrirTicketsVenta(v: Venta) {
  // Una PESTAÑA por copia (Cliente / Pizzería / Plancha). Mismo patrón robusto que
  // "Nueva venta": pre-abrimos TODAS las pestañas en blanco de un saque, dentro del
  // mismo gesto del usuario, ANTES de navegar ninguna. Si abriéramos cada una con su
  // URL final directo, la 1ª pestaña navega + auto-imprime al instante y ese efecto
  // corta el gesto, bloqueando la 2ª y 3ª (se ve sobre todo en tablet/Android).
  // Luego le asignamos la URL a cada ventana ya reservada.
  // Sin el 3er arg de "features": con él el navegador abre una *popup* (más bloqueada)
  // en vez de una pestaña. Aun así, en Android hay que permitir pop-ups del sitio.
  const copias = sectoresParaTicket(v.items);
  const ventanas = copias.map(() => {
    try { return window.open("about:blank", "_blank"); } catch { return null; }
  });
  copias.forEach((copia, i) => {
    const href = `/api/ventas/${v.id}/ticket?copia=${copia}&auto=1`;
    const w = ventanas[i];
    try {
      if (w) w.location.href = href;
      else window.open(href, "_blank"); // fallback si el pre-open falló
    } catch {}
  });
}

/**
 * Reimprime SÓLO la comanda de cocina (sin ticket cliente). Una pestaña por sector
 * (Pizzería / Plancha) o una genérica "Cocina" si la venta no tiene sector clasificado.
 * Mismo patrón robusto de pre-apertura de pestañas dentro del gesto del usuario.
 */
function abrirComandaCocina(v: Venta) {
  const copias = sectoresCocinaParaComanda(v.items);
  const ventanas = copias.map(() => {
    try { return window.open("about:blank", "_blank"); } catch { return null; }
  });
  copias.forEach((copia, i) => {
    const href = `/api/ventas/${v.id}/ticket?copia=${copia}&auto=1`;
    const w = ventanas[i];
    try {
      if (w) w.location.href = href;
      else window.open(href, "_blank");
    } catch {}
  });
}

function formatFecha(iso: string) {
  try {
    const d    = new Date(iso);
    const dd   = String(d.getDate()).padStart(2, "0");
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh   = String(d.getHours()).padStart(2, "0");
    const min  = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

// ── Constantes de estilo ───────────────────────────────────────────────────────

const inputFilterClass =
  "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none";

const tipoVentaBadge: Record<TipoVenta, string> = {
  CONTADO: "bg-blue-50 text-blue-700",
  CREDITO: "bg-orange-50 text-orange-700",
};

const ivaLabel: Record<TipoIvaVenta, string> = {
  EXENTA: "Exenta",
  "5%":   "IVA 5%",
  "10%":  "IVA 10%",
};

// ── Métricas del día ──────────────────────────────────────────────────────────

function esDeHoy(iso: string): boolean {
  try {
    const fecha = new Date(iso);
    const hoy   = new Date();
    return (
      fecha.getFullYear() === hoy.getFullYear() &&
      fecha.getMonth()    === hoy.getMonth()    &&
      fecha.getDate()     === hoy.getDate()
    );
  } catch {
    return false;
  }
}

interface MetricasHoy {
  facturacion:       number;
  cantidadVentas:    number;
  ticketPromedio:    number;
  productosVendidos: number;  // suma de todas las cantidades en todos los ítems
}

function calcularMetricas(ventas: Venta[]): MetricasHoy {
  const deHoy            = ventas.filter((v) => esDeHoy(v.fecha));
  const facturacion      = deHoy.reduce((s, v) => s + v.total, 0);
  const cantidadVentas   = deHoy.length;
  const ticketPromedio   = cantidadVentas > 0 ? facturacion / cantidadVentas : 0;
  const productosVendidos = deHoy.reduce(
    (s, v) => s + v.items.reduce((si, i) => si + i.cantidad, 0),
    0
  );
  return { facturacion, cantidadVentas, ticketPromedio, productosVendidos };
}

// ── Tarjeta métrica ───────────────────────────────────────────────────────────

function MetricCard({
  label, value, sub, accent,
}: {
  label: string; value: string; sub?: string; accent?: boolean;
}) {
  return (
    <div className={`rounded-2xl border px-5 py-4 flex flex-col gap-1 shadow-sm ${
      accent
        ? "bg-[#4FAEB2] border-[#4FAEB2] ring-1 ring-[#4FAEB2]/25"
        : "bg-white border-[#4FAEB2]/30 ring-1 ring-[#4FAEB2]/10"
    }`}>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${
        accent ? "text-white/90" : "text-[#4FAEB2]"
      }`}>
        {label}
      </span>
      <span className={`text-2xl font-bold tabular-nums leading-tight ${
        accent ? "text-white" : "text-[#3F8E91]"
      }`}>
        {value}
      </span>
      {sub && <span className={`text-xs ${accent ? "text-white/80" : "text-slate-500"}`}>{sub}</span>}
    </div>
  );
}

// ── Helpers de fila ───────────────────────────────────────────────────────────

/** Muestra el primer producto de la venta y un badge con el resto. */
function ResumenProductos({ v }: { v: Venta }) {
  const primero = v.items[0];
  if (!primero) {
    return (
      <span className="text-xs text-gray-400">Sin líneas cargadas</span>
    );
  }
  const extra   = v.items.length - 1;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-gray-800 leading-tight">
        {primero.producto_nombre}
      </span>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="font-mono text-xs text-gray-400">{primero.sku}</span>
        {extra > 0 && (
          <span className="bg-gray-100 text-gray-500 text-xs px-1.5 py-0.5 rounded-full font-medium">
            +{extra} más
          </span>
        )}
      </div>
    </div>
  );
}

/** Determina qué mostrar en la celda IVA cuando hay múltiples ítems. */
function ivaResumen(v: Venta): string {
  const tipos = [...new Set(v.items.map((i) => i.tipo_iva))];
  if (tipos.length === 1) return ivaLabel[tipos[0]];
  return "Mixto";
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function VentasPage() {
  const [todas,      setTodas]      = useState<Venta[]>([]);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroTipo, setFiltroTipo] = useState<TipoVenta | "">("");
  const [filtroIva,  setFiltroIva]  = useState<TipoIvaVenta | "">("");
  // Paginación de la tabla: cantidad por página (0 = todas) y página actual.
  const [porPagina, setPorPagina] = useState<number>(25);
  const [pagina,    setPagina]    = useState<number>(1);
  // Caja por turno: sin caja abierta no se puede vender (badge + bloqueo del botón).
  const [cajaAbierta, setCajaAbierta] = useState(false);
  /** Venta que el cliente pidió facturar. null = nadie pidió factura. */
  const [facturando, setFacturando] = useState<Venta | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVentas().then((data) => {
      if (cancelled) return;
      const ordenadas = [...data].sort((a, b) => {
        const ta = new Date(a.fecha).getTime();
        const tb = new Date(b.fecha).getTime();
        return tb - ta || b.numero_control.localeCompare(a.numero_control);
      });
      setTodas(ordenadas);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const metricas = calcularMetricas(todas);

  const filtradas = todas.filter((v) => {
    // Búsqueda global: número de control, nombre o SKU de cualquier ítem
    if (busqueda.trim() !== "") {
      const t = busqueda.toLowerCase().trim();
      const coincide =
        v.numero_control.toLowerCase().includes(t) ||
        v.items.some(
          (i) =>
            i.producto_nombre.toLowerCase().includes(t) ||
            i.sku.toLowerCase().includes(t)
        );
      if (!coincide) return false;
    }
    // Tipo de venta
    if (filtroTipo !== "" && v.tipo_venta !== filtroTipo) return false;
    // IVA: coincide si al menos un ítem tiene ese tipo
    if (filtroIva !== "" && !v.items.some((i) => i.tipo_iva === filtroIva))
      return false;
    return true;
  });

  const hayFiltros = busqueda || filtroTipo || filtroIva;

  // Volver a la página 1 cuando cambian filtros o el tamaño de página, para no
  // quedar en una página que ya no existe.
  useEffect(() => {
    setPagina(1);
  }, [busqueda, filtroTipo, filtroIva, porPagina]);

  // Recorte de la página visible (0 = mostrar todas).
  const totalPaginas = porPagina === 0 ? 1 : Math.max(1, Math.ceil(filtradas.length / porPagina));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const inicio       = porPagina === 0 ? 0 : (paginaSegura - 1) * porPagina;
  const visibles     = porPagina === 0 ? filtradas : filtradas.slice(inicio, inicio + porPagina);
  const desde        = filtradas.length === 0 ? 0 : inicio + 1;
  const hasta        = inicio + visibles.length;

  return (
    <div className="space-y-8">

      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]"
            style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }}
          />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Zentra · Operaciones
          </p>
        </div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Caja</h1>
        <p className="mt-0.5 text-xs text-slate-500">Registro de ventas y salidas de inventario</p>
      </div>

      {/* Estado de caja por turno: abrir/cerrar caja + movimientos. */}
      <CajaControlPanel onStateChange={setCajaAbierta} />

      {/* Mesas enviadas por mozos esperando cobro. */}
      <MesasPorCobrarCajaCard />

      {/* ── Métricas del día ──────────────────────────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-3">
          Resumen de hoy —{" "}
          {new Date().toLocaleDateString("es-PY", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
          })}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Facturación de hoy"
            value={`Gs. ${metricas.facturacion.toLocaleString("es-PY")}`}
            sub="Total incl. IVA"
            accent
          />
          <MetricCard
            label="Ventas de hoy"
            value={String(metricas.cantidadVentas)}
            sub={metricas.cantidadVentas === 1 ? "orden registrada" : "órdenes registradas"}
          />
          <MetricCard
            label="Ticket promedio"
            value={
              metricas.ticketPromedio > 0
                ? `Gs. ${Math.round(metricas.ticketPromedio).toLocaleString("es-PY")}`
                : "—"
            }
            sub="Por orden de venta"
          />
          <MetricCard
            label="Unidades vendidas"
            value={String(metricas.productosVendidos)}
            sub="Unidades despachadas"
          />
        </div>
      </div>

      {/* ── Tabla de ventas ───────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/15 sm:p-5 lg:p-6">

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Órdenes de venta</h2>
          {cajaAbierta ? (
            <Link
              href="/ventas/nueva"
              className="bg-[#0EA5E9] hover:bg-[#0284C7] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm"
            >
              + Nueva venta
            </Link>
          ) : (
            <span
              title="Abrí caja para poder vender"
              className="cursor-not-allowed rounded-lg bg-slate-200 px-4 py-2 text-sm font-medium text-slate-400"
            >
              + Nueva venta
            </span>
          )}
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-3 mb-5 pb-5 border-b border-gray-100">
          <input
            type="text"
            placeholder="Buscar por número, producto o SKU..."
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className={`${inputFilterClass} min-w-0 flex-1 sm:min-w-64`}
          />
          <FancySelect
            value={filtroTipo}
            onChange={(v) => setFiltroTipo(v as TipoVenta | "")}
            ariaLabel="Filtrar por tipo de venta"
            className="w-44"
            size="sm"
            options={[
              { value: "", label: "Todos los tipos" },
              { value: "CONTADO", label: "Contado" },
              { value: "CREDITO", label: "Crédito" },
            ]}
          />
          <FancySelect
            value={filtroIva}
            onChange={(v) => setFiltroIva(v as TipoIvaVenta | "")}
            ariaLabel="Filtrar por IVA"
            className="w-44"
            size="sm"
            options={[
              { value: "", label: "Todos los IVA" },
              { value: "EXENTA", label: "Exenta" },
              { value: "5%", label: "IVA 5%" },
              { value: "10%", label: "IVA 10%" },
            ]}
          />
          {hayFiltros && (
            <button
              onClick={() => { setBusqueda(""); setFiltroTipo(""); setFiltroIva(""); }}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors px-2"
            >
              Limpiar filtros
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400 whitespace-nowrap">Mostrar</span>
              <FancySelect
                value={String(porPagina)}
                onChange={(v) => setPorPagina(Number(v))}
                ariaLabel="Cantidad de ventas por página"
                className="w-28"
                size="sm"
                options={[
                  { value: "25",  label: "25" },
                  { value: "50",  label: "50" },
                  { value: "100", label: "100" },
                  { value: "0",   label: "Todas" },
                ]}
              />
            </div>
            <span className="text-sm text-gray-400 whitespace-nowrap">
              {filtradas.length} de {todas.length} ventas
            </span>
          </div>
        </div>

        {/* Tabla — min-w fuerza scroll horizontal en mobile; columnas secundarias
            (Items, Cant total, IVA, Pago) se ocultan progresivamente. */}
        <EdgeScrollArea>
          <table className="w-full min-w-[760px] lg:min-w-0 text-left text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm font-semibold">
                <th className="py-3 pr-4 font-medium">Número</th>
                <th className="py-3 pr-4 font-medium">Productos</th>
                <th className="hidden py-3 pr-4 text-center font-medium lg:table-cell">Ítems</th>
                <th className="py-3 pr-4 font-medium text-right hidden lg:table-cell">Cant. total</th>
                <th className="py-3 pr-4 font-medium hidden lg:table-cell">IVA</th>
                <th className="py-3 pr-4 font-medium text-right">Total</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Tipo</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Pago</th>
                <th className="py-3 pr-4 font-medium">Fecha</th>
                <th className="py-3 pr-4 font-medium text-center">Factura</th>
                <th className="py-3 font-medium text-center">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    {todas.length === 0
                      ? "No hay ventas registradas"
                      : "Ninguna venta coincide con los filtros"}
                  </td>
                </tr>
              ) : (
                visibles.map((v) => {
                  const cantTotal = v.items.reduce((s, i) => s + i.cantidad, 0);
                  return (
                    <tr
                      key={v.id}
                      className={`border-b border-slate-200 last:border-0 transition-colors ${
                        v.estado === "anulada"
                          ? "bg-rose-50/40 text-slate-400"
                          : "hover:bg-[#4FAEB2]/[0.04]"
                      }`}
                    >
                      <td className="py-4 pr-4 font-mono text-xs text-gray-500 align-middle">
                        {v.numero_control}
                        {v.estado === "anulada" && (
                          <span className="mt-1 block w-fit rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">
                            Anulada
                          </span>
                        )}
                      </td>
                      <td className="py-4 pr-4 align-middle">
                        <ResumenProductos v={v} />
                      </td>
                      <td className="hidden py-4 pr-4 text-center align-middle lg:table-cell">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                          {v.items.length}
                        </span>
                      </td>
                      <td className="py-4 pr-4 text-right tabular-nums text-gray-700 align-middle hidden lg:table-cell">
                        {cantTotal}
                      </td>
                      <td className="py-4 pr-4 align-middle hidden lg:table-cell">
                        <span className="px-2 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700">
                          {ivaResumen(v)}
                        </span>
                      </td>
                      <td className={`py-4 pr-4 text-right tabular-nums font-semibold align-middle ${
                        v.estado === "anulada" ? "text-slate-400 line-through" : "text-gray-800"
                      }`}>
                        {formatGs(v.total)}
                      </td>
                      <td className="hidden py-4 pr-4 align-middle lg:table-cell">
                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${tipoVentaBadge[v.tipo_venta]}`}>
                          {v.tipo_venta === "CONTADO"
                            ? "Contado"
                            : `Crédito ${v.plazo_dias ?? ""}d`}
                        </span>
                      </td>
                      <td className="hidden py-4 pr-4 align-middle text-xs text-gray-600 lg:table-cell">
                        {v.metodo_pago === "tarjeta" ? "Tarjeta"
                          : v.metodo_pago === "transferencia" ? "Transfer."
                          : v.metodo_pago === "qr" ? "QR"
                          : v.metodo_pago === "efectivo" ? "Efectivo"
                          : "—"}
                      </td>
                      <td className="py-4 pr-4 text-gray-500 text-xs tabular-nums align-middle">
                        {formatFecha(v.fecha)}
                      </td>
                      <td className="py-4 pr-4 text-center align-middle">
                        {v.factura_id ? (
                          <Link
                            href={`/facturas/${v.factura_id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-[#4FAEB2]/30 bg-[#4FAEB2]/10 px-3 py-1.5 text-xs font-semibold text-[#2F6E71] transition-colors hover:bg-[#4FAEB2]/20"
                            title="Ver la factura de esta venta"
                          >
                            <FileText className="h-3.5 w-3.5" aria-hidden />
                            Ver
                          </Link>
                        ) : v.estado === "anulada" ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFacturando(v)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-[#4FAEB2]/50 hover:bg-[#4FAEB2]/5 hover:text-[#2F6E71]"
                            title="Emitir factura para esta venta"
                          >
                            <FileText className="h-3.5 w-3.5" aria-hidden />
                            Facturar
                          </button>
                        )}
                      </td>
                      <td className="py-4 text-center align-middle">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => abrirTicketsVenta(v)}
                            className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors"
                            title="Abrir Cliente + Pizzería + Plancha en pestañas separadas"
                          >
                            Imprimir
                          </button>
                          <button
                            type="button"
                            onClick={() => abrirComandaCocina(v)}
                            className="inline-flex items-center justify-center rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:border-amber-300 hover:bg-amber-100 transition-colors"
                            title="Reimprimir sólo la comanda de cocina (sin ticket cliente)"
                          >
                            Comanda cocina
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </EdgeScrollArea>

        {/* Controles de paginación — sólo si hay más de una página. */}
        {filtradas.length > 0 && porPagina !== 0 && totalPaginas > 1 && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
            <span className="text-sm text-gray-500 tabular-nums">
              Mostrando <span className="font-medium text-gray-700">{desde}–{hasta}</span> de{" "}
              <span className="font-medium text-gray-700">{filtradas.length}</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPagina((p) => Math.max(1, p - 1))}
                disabled={paginaSegura <= 1}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="px-2 text-sm text-gray-500 tabular-nums">
                Página {paginaSegura} de {totalPaginas}
              </span>
              <button
                type="button"
                onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
                disabled={paginaSegura >= totalPaginas}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}

      </div>

      {/* FAB mobile: acceso 1-tap a "+ Nueva venta" — solo con caja abierta. */}
      {cajaAbierta && <MobileFab href="/ventas/nueva" label="Nueva venta" />}

      {facturando && (
        <FacturarVentaModal
          ventaId={facturando.id}
          numeroControl={facturando.numero_control}
          total={facturando.total}
          onClose={() => setFacturando(null)}
          onEmitida={(facturaId) => {
            setFacturando(null);
            // Al detalle, que es donde se firma y se manda al SET.
            window.location.href = `/facturas/${facturaId}`;
          }}
        />
      )}
    </div>
  );
}
