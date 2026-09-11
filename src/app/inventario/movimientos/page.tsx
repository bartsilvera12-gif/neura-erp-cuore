"use client";

import SelectField from "@/components/ui/SelectField";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getMovimientos } from "@/lib/inventario/storage";
import type { MovimientoInventario, TipoMovimiento, OrigenMovimiento } from "@/lib/inventario/types";

const tipoBadge: Record<TipoMovimiento, string> = {
  ENTRADA: "bg-green-100 text-green-700",
  SALIDA: "bg-red-100 text-red-700",
  AJUSTE: "bg-yellow-100 text-yellow-700",
};

const origenLabel: Record<OrigenMovimiento, string> = {
  compra: "Compra",
  venta: "Venta",
  ajuste_manual: "Ajuste manual",
  inventario_inicial: "Inventario inicial",
  consumo_receta: "Receta",
  produccion: "Producción",
};

const origenBadge: Record<OrigenMovimiento, string> = {
  compra: "bg-blue-50 text-blue-600",
  venta: "bg-purple-50 text-purple-600",
  ajuste_manual: "bg-gray-100 text-gray-600",
  inventario_inicial: "bg-orange-50 text-orange-600",
  consumo_receta: "bg-[#4FAEB2]/12 text-[#2F6E71]",
  produccion: "bg-emerald-50 text-emerald-700",
};

function formatGs(valor: number) {
  return `Gs. ${valor.toLocaleString("es-PY")}`;
}

function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy}, ${hh}:${min}`;
  } catch {
    return iso;
  }
}

/** Mismo borde, radio y foco que FancySelect, para que los filtros se lean
 *  como una sola fila y no como controles sueltos de estilos distintos. */
const inputFilterClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";

const filtroLabelClass =
  "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

export default function MovimientosPage() {
  const [todos, setTodos] = useState<MovimientoInventario[]>([]);

  // Filtros
  const [busqueda, setBusqueda] = useState("");
  const [filtroTipo, setFiltroTipo] = useState<TipoMovimiento | "">("");
  const [filtroOrigen, setFiltroOrigen] = useState<OrigenMovimiento | "">("");
  const [fechaDesde, setFechaDesde] = useState("");  // "YYYY-MM-DD"
  const [fechaHasta, setFechaHasta] = useState(""); // "YYYY-MM-DD"

  useEffect(() => {
    let cancelled = false;
    getMovimientos().then((data) => {
      if (!cancelled) setTodos(data);
    });
    return () => { cancelled = true; };
  }, []);

  const filtrados = todos.filter((m) => {
    const texto = busqueda.toLowerCase();
    const coincideTexto =
      texto === "" ||
      m.producto_nombre.toLowerCase().includes(texto) ||
      m.producto_sku.toLowerCase().includes(texto);
    const coincideTipo = filtroTipo === "" || m.tipo === filtroTipo;
    const coincideOrigen = filtroOrigen === "" || m.origen === filtroOrigen;

    // Compara solo la parte de fecha (YYYY-MM-DD) del ISO string del movimiento
    const fechaMov = m.fecha.slice(0, 10); // "YYYY-MM-DD"
    const coincideDesde = fechaDesde === "" || fechaMov >= fechaDesde;
    const coincideHasta = fechaHasta === "" || fechaMov <= fechaHasta;

    return coincideTexto && coincideTipo && coincideOrigen && coincideDesde && coincideHasta;
  });

  return (
    <div className="space-y-6">

      <div>
        <h1 className="text-2xl font-bold text-slate-800">Movimientos de inventario</h1>
        <p className="mt-1 text-sm text-slate-500">Registro de entradas, salidas y ajustes de stock.</p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">

        {/* Cabecera: qué es esta pantalla y la acción principal */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-800">Historial</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {filtrados.length === todos.length
                ? `${todos.length} movimiento${todos.length === 1 ? "" : "s"}`
                : `${filtrados.length} de ${todos.length} movimientos`}
              {" · se generan solos desde "}
              <Link href="/compras" className="font-medium text-slate-600 underline-offset-2 hover:underline">
                Compras
              </Link>
              {" y Ventas"}
            </p>
          </div>
          <Link
            href="/inventario/movimientos/nuevo"
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Nuevo movimiento
          </Link>
        </div>

        {/* Filtros: grilla con etiquetas, en vez de controles sueltos de anchos
            distintos apilados sin jerarquía. */}
        <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2 lg:col-span-1">
              <label className={filtroLabelClass}>Buscar</label>
              <input
                type="text"
                placeholder="Producto o SKU…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                className={inputFilterClass}
              />
            </div>
            <div>
              <label className={filtroLabelClass}>Tipo</label>
              <SelectField
                value={filtroTipo}
                onChange={(e) => setFiltroTipo(e.target.value as TipoMovimiento | "")}
                size="sm"
              >
                <option value="">Todos los tipos</option>
                <option value="ENTRADA">Entrada</option>
                <option value="SALIDA">Salida</option>
                <option value="AJUSTE">Ajuste</option>
              </SelectField>
            </div>
            <div>
              <label className={filtroLabelClass}>Origen</label>
              <SelectField
                value={filtroOrigen}
                onChange={(e) => setFiltroOrigen(e.target.value as OrigenMovimiento | "")}
                size="sm"
              >
                <option value="">Todos los orígenes</option>
                <option value="compra">Compra</option>
                <option value="venta">Venta</option>
                <option value="ajuste_manual">Ajuste manual</option>
                <option value="consumo_receta">Receta</option>
                <option value="produccion">Producción</option>
              </SelectField>
            </div>
            <div>
              <label className={filtroLabelClass}>Período</label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  aria-label="Desde"
                  value={fechaDesde}
                  onChange={(e) => setFechaDesde(e.target.value)}
                  max={fechaHasta || undefined}
                  className={inputFilterClass}
                />
                <input
                  type="date"
                  aria-label="Hasta"
                  value={fechaHasta}
                  onChange={(e) => setFechaHasta(e.target.value)}
                  min={fechaDesde || undefined}
                  className={inputFilterClass}
                />
              </div>
            </div>
          </div>

          {(busqueda || filtroTipo || filtroOrigen || fechaDesde || fechaHasta) && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBusqueda("");
                  setFiltroTipo("");
                  setFiltroOrigen("");
                  setFechaDesde("");
                  setFechaHasta("");
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-white hover:text-slate-800"
              >
                Limpiar filtros
              </button>
            </div>
          )}
        </div>

        {/* Tabla — min-w activa el scroll horizontal en mobile;
            SKU, Origen, Usuario se ocultan en pantallas chicas. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] sm:min-w-0 text-left text-sm">
            <thead className="bg-slate-50/80">
              <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-semibold">Producto</th>
                <th className="px-3 py-3 font-semibold hidden md:table-cell">SKU</th>
                <th className="px-3 py-3 font-semibold">Tipo</th>
                <th className="px-3 py-3 font-semibold text-right">Cantidad</th>
                <th className="px-3 py-3 font-semibold text-right hidden lg:table-cell">Costo unit.</th>
                <th className="px-3 py-3 font-semibold hidden md:table-cell">Origen</th>
                <th className="px-3 py-3 font-semibold hidden lg:table-cell">Usuario</th>
                <th className="px-5 py-3 font-semibold text-right">Fecha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtrados.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-14 text-center text-sm text-slate-400">
                    {todos.length === 0
                      ? "No hay movimientos registrados"
                      : "Ningún movimiento coincide con los filtros"}
                  </td>
                </tr>
              ) : (
                filtrados.map((m) => {
                  const signo =
                    m.tipo === "ENTRADA" ? "+" : m.tipo === "SALIDA" ? "−" : m.cantidad >= 0 ? "+" : "";
                  const cantidadColor =
                    m.tipo === "ENTRADA"
                      ? "text-green-600"
                      : m.tipo === "SALIDA"
                      ? "text-red-600"
                      : "text-yellow-600";

                  return (
                    <tr key={m.id} className="transition-colors hover:bg-slate-50">
                      <td className="px-5 py-3.5 font-medium text-slate-800">{m.producto_nombre}</td>
                      <td className="px-3 py-3.5 font-mono text-xs text-slate-500 hidden md:table-cell">{m.producto_sku}</td>
                      <td className="px-3 py-3.5">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${tipoBadge[m.tipo]}`}>
                          {m.tipo}
                        </span>
                      </td>
                      <td className={`px-3 py-3.5 text-right font-semibold tabular-nums ${cantidadColor}`}>
                        {signo}{Math.abs(m.cantidad)}
                      </td>
                      <td className="px-3 py-3.5 text-right tabular-nums text-slate-600 hidden lg:table-cell">
                        {formatGs(m.costo_unitario)}
                      </td>
                      <td className="px-3 py-3.5 hidden md:table-cell">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${origenBadge[m.origen]}`}>
                          {origenLabel[m.origen]}
                        </span>
                      </td>
                      <td className="px-3 py-3.5 text-xs text-slate-600 hidden lg:table-cell">
                        {m.usuario_nombre ?? <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-5 py-3.5 text-right text-xs tabular-nums text-slate-500">
                        {formatFecha(m.fecha)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

      </div>

    </div>
  );
}
