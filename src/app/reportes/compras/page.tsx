"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import SelectField from "@/components/ui/SelectField";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  avisoError, badgeMarca, badgeNeutro, btnGhost, btnSecundario, card, cardHead,
  celdaVacia, input, label, tabla, tbody, td, tdFuerte, th, thRow, thead, tr,
} from "@/lib/ui/estilos";

type Reporte = {
  resumen: {
    ordenes: number; lineas: number; total: number; gravada: number; iva: number;
    contado: number; credito: number; proveedores: number;
  };
  por_proveedor: Array<{ proveedor_id: string; proveedor: string; ordenes: number; total: number }>;
  por_producto: Array<{ producto: string; cantidad: number; total: number; costo_promedio: number }>;
  por_dia: Array<{ dia: string; total: number; ordenes: number }>;
  detalle: Array<{
    id: string; numero_control: string; proveedor_nombre: string; producto_nombre: string;
    cantidad: number | string; total: number | string; tipo_pago: string;
    plazo_dias: number | null; fecha: string;
  }>;
};

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

/** Primer día del mes actual, en formato YYYY-MM-DD local. */
function inicioDeMes(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function hoy(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Tarjeta de indicador. `destacado` la pinta en la paleta de marca. */
function Kpi({ etiqueta, valor, nota, destacado }: {
  etiqueta: string; valor: string; nota?: string; destacado?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${
        destacado
          ? "border-[#4FAEB2]/30 bg-[#4FAEB2]/8"
          : "border-slate-200/80 bg-white"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{etiqueta}</p>
      <p className={`mt-2 text-2xl font-bold tabular-nums ${destacado ? "text-[#2F6E71]" : "text-slate-900"}`}>
        {valor}
      </p>
      {nota && <p className="mt-1 text-xs text-slate-500">{nota}</p>}
    </div>
  );
}

export default function ReporteComprasPage() {
  const [desde, setDesde] = useState(inicioDeMes);
  const [hasta, setHasta] = useState(hoy);
  const [proveedorId, setProveedorId] = useState("");
  const [data, setData] = useState<Reporte | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (desde) qs.set("desde", desde);
      if (hasta) qs.set("hasta", hasta);
      if (proveedorId) qs.set("proveedor", proveedorId);
      const res = await fetchWithSupabaseSession(`/api/reportes/compras?${qs}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "No se pudo generar el reporte.");
        setData(null);
      } else {
        setData(body.data as Reporte);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setCargando(false);
    }
  }, [desde, hasta, proveedorId]);

  useEffect(() => { void cargar(); }, [cargar]);

  /** El selector de proveedor se arma con los que compraron en el período: no
   *  tiene sentido ofrecer filtrar por uno que no aparece en el resultado. */
  const proveedoresDelPeriodo = useMemo(
    () => data?.por_proveedor ?? [],
    [data]
  );

  const maxDia = useMemo(
    () => Math.max(1, ...(data?.por_dia ?? []).map((d) => d.total)),
    [data]
  );

  const r = data?.resumen;
  const promedioOrden = r && r.ordenes > 0 ? r.total / r.ordenes : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Reporte de compras</h1>
          <p className="mt-1 text-sm text-slate-500">
            Qué se compró, a quién y cuánto queda a crédito.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportExcelButton url="/api/compras/export" />
          <Link href="/reportes" className={btnGhost}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Volver a Reportes
          </Link>
        </div>
      </div>

      {error && <div className={avisoError}>{error}</div>}

      {/* Filtros */}
      <div className={card}>
        <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={label}>Desde</label>
            <input type="date" value={desde} max={hasta || undefined}
              onChange={(e) => setDesde(e.target.value)} className={input} />
          </div>
          <div>
            <label className={label}>Hasta</label>
            <input type="date" value={hasta} min={desde || undefined}
              onChange={(e) => setHasta(e.target.value)} className={input} />
          </div>
          <div>
            <label className={label}>Proveedor</label>
            <SelectField value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
              <option value="">Todos los proveedores</option>
              {proveedoresDelPeriodo.map((p) => (
                <option key={p.proveedor_id} value={p.proveedor_id}>{p.proveedor}</option>
              ))}
            </SelectField>
          </div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => { setDesde(inicioDeMes()); setHasta(hoy()); setProveedorId(""); }}
              className={btnSecundario}
            >
              Este mes
            </button>
          </div>
        </div>
      </div>

      {cargando && !data ? (
        <div className={`${card} p-10 text-center text-sm text-slate-400`}>Generando reporte…</div>
      ) : !r ? null : (
        <>
          {/* Indicadores */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi etiqueta="Total comprado" valor={formatGs(r.total)}
              nota={`${r.ordenes} orden${r.ordenes === 1 ? "" : "es"} · ${r.lineas} producto${r.lineas === 1 ? "" : "s"} · ${r.proveedores} proveedor${r.proveedores === 1 ? "" : "es"}`}
              destacado />
            <Kpi etiqueta="IVA incluido" valor={formatGs(r.iva)}
              nota={`Gravada ${formatGs(r.gravada)}`} />
            <Kpi etiqueta="A crédito" valor={formatGs(r.credito)}
              nota={r.credito > 0 ? "Pendiente de pago al proveedor" : "Nada a crédito en el período"} />
            <Kpi etiqueta="Promedio por orden" valor={formatGs(promedioOrden)}
              nota={`Contado ${formatGs(r.contado)}`} />
          </div>

          {/* Compras por día. Barras con divs: para un período de un mes es más
              legible que un gráfico completo, y no arrastra otra librería. */}
          {data.por_dia.length > 0 && (
            <div className={card}>
              <div className={cardHead}>
                <h2 className="text-base font-semibold text-slate-800">Compras por día</h2>
                <span className="text-xs text-slate-500">{data.por_dia.length} día(s) con compras</span>
              </div>
              <div className="space-y-2 p-5">
                {data.por_dia.map((d) => (
                  <div key={d.dia} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-xs tabular-nums text-slate-500">
                      {formatFecha(d.dia)}
                    </span>
                    <div className="h-6 min-w-0 flex-1 overflow-hidden rounded-md bg-slate-100">
                      <div
                        className="h-full rounded-md bg-gradient-to-r from-[#4FAEB2] to-[#3F8E91]"
                        style={{ width: `${Math.max(2, (d.total / maxDia) * 100)}%` }}
                      />
                    </div>
                    <span className="w-32 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-700">
                      {formatGs(d.total)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Por proveedor */}
            <div className={card}>
              <div className={cardHead}>
                <h2 className="text-base font-semibold text-slate-800">Por proveedor</h2>
              </div>
              <div className="overflow-x-auto">
                <table className={tabla}>
                  <thead className={thead}>
                    <tr className={thRow}>
                      <th className={th}>Proveedor</th>
                      <th className={`${th} text-right`}>Órdenes</th>
                      <th className={`${th} text-right`}>Total</th>
                      <th className={`${th} text-right`}>%</th>
                    </tr>
                  </thead>
                  <tbody className={tbody}>
                    {data.por_proveedor.length === 0 ? (
                      <tr><td colSpan={4} className={celdaVacia}>Sin compras en el período.</td></tr>
                    ) : (
                      data.por_proveedor.map((p) => (
                        <tr key={p.proveedor_id} className={tr}>
                          <td className={tdFuerte}>{p.proveedor}</td>
                          <td className="px-5 py-3.5 text-right tabular-nums text-slate-600">{p.ordenes}</td>
                          <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                            {formatGs(p.total)}
                          </td>
                          <td className="px-5 py-3.5 text-right text-xs tabular-nums text-slate-500">
                            {r.total > 0 ? `${((p.total / r.total) * 100).toFixed(1)}%` : "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Por producto */}
            <div className={card}>
              <div className={cardHead}>
                <h2 className="text-base font-semibold text-slate-800">Por producto</h2>
              </div>
              <div className="overflow-x-auto">
                <table className={tabla}>
                  <thead className={thead}>
                    <tr className={thRow}>
                      <th className={th}>Producto</th>
                      <th className={`${th} text-right`}>Cantidad</th>
                      <th className={`${th} text-right`}>Costo prom.</th>
                      <th className={`${th} text-right`}>Total</th>
                    </tr>
                  </thead>
                  <tbody className={tbody}>
                    {data.por_producto.length === 0 ? (
                      <tr><td colSpan={4} className={celdaVacia}>Sin compras en el período.</td></tr>
                    ) : (
                      data.por_producto.map((p) => (
                        <tr key={p.producto} className={tr}>
                          <td className={tdFuerte}>{p.producto}</td>
                          <td className="px-5 py-3.5 text-right tabular-nums text-slate-600">{p.cantidad}</td>
                          <td className="px-5 py-3.5 text-right text-xs tabular-nums text-slate-500">
                            {formatGs(p.costo_promedio)}
                          </td>
                          <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                            {formatGs(p.total)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Detalle */}
          <div className={card}>
            <div className={cardHead}>
              <div>
                <h2 className="text-base font-semibold text-slate-800">Detalle</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {data.detalle.length} orden{data.detalle.length === 1 ? "" : "es"}
                  {data.detalle.length >= 500 ? " (se muestran las 500 más recientes)" : ""}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className={`${tabla} min-w-[760px] lg:min-w-0`}>
                <thead className={thead}>
                  <tr className={thRow}>
                    <th className={th}>N° Control</th>
                    <th className={th}>Fecha</th>
                    <th className={th}>Proveedor</th>
                    <th className={th}>Producto</th>
                    <th className={`${th} text-right`}>Cant.</th>
                    <th className={th}>Pago</th>
                    <th className={`${th} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody className={tbody}>
                  {data.detalle.length === 0 ? (
                    <tr><td colSpan={7} className={celdaVacia}>Sin compras en el período.</td></tr>
                  ) : (
                    data.detalle.map((c) => (
                      <tr key={c.id} className={tr}>
                        <td className="px-5 py-3.5 font-mono text-xs text-slate-500">{c.numero_control}</td>
                        <td className={`${td} whitespace-nowrap tabular-nums`}>{formatFecha(c.fecha)}</td>
                        <td className={tdFuerte}>{c.proveedor_nombre}</td>
                        <td className={td}>{c.producto_nombre}</td>
                        <td className="px-5 py-3.5 text-right tabular-nums text-slate-600">{Number(c.cantidad)}</td>
                        <td className="px-5 py-3.5">
                          <span className={c.tipo_pago === "credito" ? badgeMarca : badgeNeutro}>
                            {c.tipo_pago === "credito" ? `Crédito ${c.plazo_dias ?? ""}d` : "Contado"}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                          {formatGs(Number(c.total))}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
