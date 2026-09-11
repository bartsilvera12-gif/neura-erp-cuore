"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import SelectField from "@/components/ui/SelectField";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import {
  avisoError, avisoInfo, badgeError, badgeMarca, badgeNeutro, btnGhost, btnSecundario,
  card, cardHead, celdaVacia, input, label, tabla, tbody, td, tdFuerte, th, thRow, thead, tr,
} from "@/lib/ui/estilos";

type Modalidad = "mesa" | "local" | "delivery" | "carry_out" | "para_llevar" | "sin_dato";
type Grupo = "local" | "delivery" | "retiro" | "otros";

const MODALIDAD_LABEL: Record<Modalidad, string> = {
  mesa: "Salón (mesa)",
  local: "En el local (mostrador)",
  delivery: "Delivery",
  carry_out: "Retiro / Carry out",
  para_llevar: "Para llevar (mostrador)",
  sin_dato: "Sin modalidad",
};

const GRUPO_LABEL: Record<Grupo, string> = {
  local: "En el local",
  delivery: "Delivery",
  retiro: "Retiro y para llevar",
  otros: "Sin clasificar",
};

/** Un color por grupo, para que la barra y el badge cuenten lo mismo. */
const GRUPO_COLOR: Record<Grupo, string> = {
  local: "from-[#4FAEB2] to-[#3F8E91]",
  delivery: "from-amber-400 to-amber-600",
  retiro: "from-violet-400 to-violet-600",
  otros: "from-slate-300 to-slate-400",
};

const METODO_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  transferencia: "Transferencia",
  qr: "QR",
  sin_dato: "Sin registrar",
};

type Reporte = {
  resumen: {
    ventas: number; total: number; gravada: number; iva: number;
    ticket_promedio: number; anuladas: number; total_anulado: number;
  };
  por_modalidad: Array<{
    modalidad: Modalidad; grupo: Grupo; ventas: number; total: number; ticket_promedio: number;
  }>;
  por_metodo_pago: Array<{ metodo: string; ventas: number; total: number }>;
  por_dia: Array<{ dia: string; total: number; ventas: number }>;
  por_producto: Array<{ producto: string; cantidad: number; total: number }>;
  detalle: Array<{
    id: string; numero_control: string; fecha: string; modalidad: Modalidad;
    referencia: string | null; metodo_pago: string | null; estado: string; total: number;
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
        destacado ? "border-[#4FAEB2]/30 bg-[#4FAEB2]/8" : "border-slate-200/80 bg-white"
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

export default function ReporteVentasPage() {
  const [desde, setDesde] = useState(inicioDeMes);
  const [hasta, setHasta] = useState(hoy);
  const [modalidad, setModalidad] = useState<"" | Modalidad>("");
  const [incluirAnuladas, setIncluirAnuladas] = useState(false);
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
      if (modalidad) qs.set("modalidad", modalidad);
      if (incluirAnuladas) qs.set("anuladas", "1");
      const res = await fetchWithSupabaseSession(`/api/reportes/ventas?${qs}`, { cache: "no-store" });
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
  }, [desde, hasta, modalidad, incluirAnuladas]);

  useEffect(() => { void cargar(); }, [cargar]);

  /** Rollup de las modalidades a los tres destinos que le importan al local. */
  const porGrupo = useMemo(() => {
    const acc = new Map<Grupo, { ventas: number; total: number }>();
    for (const m of data?.por_modalidad ?? []) {
      const a = acc.get(m.grupo) ?? { ventas: 0, total: 0 };
      a.ventas += m.ventas;
      a.total += m.total;
      acc.set(m.grupo, a);
    }
    return (["local", "delivery", "retiro", "otros"] as Grupo[])
      .map((g) => ({ grupo: g, ...(acc.get(g) ?? { ventas: 0, total: 0 }) }))
      .filter((g) => g.ventas > 0);
  }, [data]);

  const maxDia = useMemo(
    () => Math.max(1, ...(data?.por_dia ?? []).map((d) => d.total)),
    [data]
  );

  /** Descarga el detalle tal cual se ve, sin pasar por otro endpoint. */
  function exportarCsv() {
    if (!data) return;
    const filas = [
      ["N° Control", "Fecha", "Modalidad", "Referencia", "Método de pago", "Estado", "Total"],
      ...data.detalle.map((v) => [
        v.numero_control,
        formatFecha(v.fecha),
        MODALIDAD_LABEL[v.modalidad],
        v.referencia ?? "",
        v.metodo_pago ? METODO_LABEL[v.metodo_pago] ?? v.metodo_pago : "",
        v.estado,
        String(Math.round(v.total)),
      ]),
    ];
    const csv = filas
      .map((f) => f.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
      .join("\r\n");
    // BOM para que Excel en español abra los acentos bien.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ventas_${desde}_${hasta}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const r = data?.resumen;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800">Reporte de ventas</h1>
          <p className="mt-1 text-sm text-slate-500">
            Cuánto se vendió y por dónde salió cada pedido: salón, delivery o retiro.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={exportarCsv} disabled={!data} className={btnSecundario}>
            <Download className="h-4 w-4" aria-hidden />
            Exportar CSV
          </button>
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
            <label className={label}>Modalidad</label>
            <SelectField value={modalidad} onChange={(e) => setModalidad(e.target.value as "" | Modalidad)}>
              <option value="">Todas las modalidades</option>
              {(Object.keys(MODALIDAD_LABEL) as Modalidad[]).map((m) => (
                <option key={m} value={m}>{MODALIDAD_LABEL[m]}</option>
              ))}
            </SelectField>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={incluirAnuladas}
                onChange={(e) => setIncluirAnuladas(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-[#4FAEB2] focus:ring-[#4FAEB2]"
              />
              Incluir anuladas
            </label>
            <button
              type="button"
              onClick={() => {
                setDesde(inicioDeMes()); setHasta(hoy());
                setModalidad(""); setIncluirAnuladas(false);
              }}
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
            <Kpi etiqueta="Total vendido" valor={formatGs(r.total)}
              nota={`${r.ventas} venta${r.ventas === 1 ? "" : "s"}`} destacado />
            <Kpi etiqueta="Ticket promedio" valor={formatGs(r.ticket_promedio)}
              nota="Promedio por venta del período" />
            <Kpi etiqueta="IVA incluido" valor={formatGs(r.iva)}
              nota={`Gravada ${formatGs(r.gravada)}`} />
            <Kpi etiqueta="Anuladas" valor={String(r.anuladas)}
              nota={r.anuladas > 0 ? `${formatGs(r.total_anulado)} sin contar` : "Ninguna en el período"} />
          </div>

          {!incluirAnuladas && r.anuladas > 0 && (
            <div className={avisoInfo}>
              Los totales excluyen {r.anuladas} venta{r.anuladas === 1 ? "" : "s"} anulada
              {r.anuladas === 1 ? "" : "s"} por {formatGs(r.total_anulado)}. Marcá
              &quot;Incluir anuladas&quot; si querés verlas.
            </div>
          )}

          {/* Reparto por destino del pedido: la pregunta central del reporte. */}
          <div className={card}>
            <div className={cardHead}>
              <h2 className="text-base font-semibold text-slate-800">Por dónde salió</h2>
              <span className="text-xs text-slate-500">Salón, delivery y retiro</span>
            </div>

            {porGrupo.length === 0 ? (
              <p className={celdaVacia}>Sin ventas en el período.</p>
            ) : (
              <div className="space-y-5 p-5">
                {/* Barra apilada: proporción de un vistazo. */}
                <div className="flex h-4 w-full overflow-hidden rounded-full bg-slate-100">
                  {porGrupo.map((g) => (
                    <div
                      key={g.grupo}
                      title={`${GRUPO_LABEL[g.grupo]}: ${formatGs(g.total)}`}
                      className={`h-full bg-gradient-to-r ${GRUPO_COLOR[g.grupo]}`}
                      style={{ width: `${r.total > 0 ? (g.total / r.total) * 100 : 0}%` }}
                    />
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {porGrupo.map((g) => (
                    <div key={g.grupo} className="rounded-xl border border-slate-200/80 bg-white p-4">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full bg-gradient-to-r ${GRUPO_COLOR[g.grupo]}`} />
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {GRUPO_LABEL[g.grupo]}
                        </p>
                      </div>
                      <p className="mt-2 text-xl font-bold tabular-nums text-slate-900">{formatGs(g.total)}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {g.ventas} venta{g.ventas === 1 ? "" : "s"} ·{" "}
                        {r.total > 0 ? `${((g.total / r.total) * 100).toFixed(1)}%` : "—"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Desglose fino: separa mesa de mostrador, y retiro de para llevar. */}
            <div className="overflow-x-auto border-t border-slate-100">
              <table className={tabla}>
                <thead className={thead}>
                  <tr className={thRow}>
                    <th className={th}>Modalidad</th>
                    <th className={th}>Destino</th>
                    <th className={`${th} text-right`}>Ventas</th>
                    <th className={`${th} text-right`}>Ticket prom.</th>
                    <th className={`${th} text-right`}>Total</th>
                    <th className={`${th} text-right`}>%</th>
                  </tr>
                </thead>
                <tbody className={tbody}>
                  {data.por_modalidad.length === 0 ? (
                    <tr><td colSpan={6} className={celdaVacia}>Sin ventas en el período.</td></tr>
                  ) : (
                    data.por_modalidad.map((m) => (
                      <tr key={m.modalidad} className={tr}>
                        <td className={tdFuerte}>{MODALIDAD_LABEL[m.modalidad]}</td>
                        <td className="px-5 py-3.5">
                          <span className={m.grupo === "otros" ? badgeNeutro : badgeMarca}>
                            {GRUPO_LABEL[m.grupo]}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right tabular-nums text-slate-600">{m.ventas}</td>
                        <td className="px-5 py-3.5 text-right text-xs tabular-nums text-slate-500">
                          {formatGs(m.ticket_promedio)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                          {formatGs(m.total)}
                        </td>
                        <td className="px-5 py-3.5 text-right text-xs tabular-nums text-slate-500">
                          {r.total > 0 ? `${((m.total / r.total) * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Ventas por día. Barras con divs: para un mes es más legible que un
              gráfico completo, y no arrastra otra librería. */}
          {data.por_dia.length > 0 && (
            <div className={card}>
              <div className={cardHead}>
                <h2 className="text-base font-semibold text-slate-800">Ventas por día</h2>
                <span className="text-xs text-slate-500">{data.por_dia.length} día(s) con ventas</span>
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
            {/* Más vendidos */}
            <div className={card}>
              <div className={cardHead}>
                <h2 className="text-base font-semibold text-slate-800">Más vendidos</h2>
              </div>
              <div className="overflow-x-auto">
                <table className={tabla}>
                  <thead className={thead}>
                    <tr className={thRow}>
                      <th className={th}>Producto</th>
                      <th className={`${th} text-right`}>Cantidad</th>
                      <th className={`${th} text-right`}>Total</th>
                    </tr>
                  </thead>
                  <tbody className={tbody}>
                    {data.por_producto.length === 0 ? (
                      <tr><td colSpan={3} className={celdaVacia}>Sin ventas en el período.</td></tr>
                    ) : (
                      data.por_producto.map((p) => (
                        <tr key={p.producto} className={tr}>
                          <td className={tdFuerte}>{p.producto}</td>
                          <td className="px-5 py-3.5 text-right tabular-nums text-slate-600">{p.cantidad}</td>
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

            {/* Método de pago */}
            <div className={card}>
              <div className={cardHead}>
                <h2 className="text-base font-semibold text-slate-800">Cómo pagaron</h2>
              </div>
              <div className="overflow-x-auto">
                <table className={tabla}>
                  <thead className={thead}>
                    <tr className={thRow}>
                      <th className={th}>Método</th>
                      <th className={`${th} text-right`}>Ventas</th>
                      <th className={`${th} text-right`}>Total</th>
                      <th className={`${th} text-right`}>%</th>
                    </tr>
                  </thead>
                  <tbody className={tbody}>
                    {data.por_metodo_pago.length === 0 ? (
                      <tr><td colSpan={4} className={celdaVacia}>Sin ventas en el período.</td></tr>
                    ) : (
                      data.por_metodo_pago.map((m) => (
                        <tr key={m.metodo} className={tr}>
                          <td className={tdFuerte}>{METODO_LABEL[m.metodo] ?? m.metodo}</td>
                          <td className="px-5 py-3.5 text-right tabular-nums text-slate-600">{m.ventas}</td>
                          <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                            {formatGs(m.total)}
                          </td>
                          <td className="px-5 py-3.5 text-right text-xs tabular-nums text-slate-500">
                            {r.total > 0 ? `${((m.total / r.total) * 100).toFixed(1)}%` : "—"}
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
                  {data.detalle.length} venta{data.detalle.length === 1 ? "" : "s"}
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
                    <th className={th}>Modalidad</th>
                    <th className={th}>Referencia</th>
                    <th className={th}>Pago</th>
                    <th className={`${th} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody className={tbody}>
                  {data.detalle.length === 0 ? (
                    <tr><td colSpan={6} className={celdaVacia}>Sin ventas en el período.</td></tr>
                  ) : (
                    data.detalle.map((v) => (
                      <tr key={v.id} className={tr}>
                        <td className="px-5 py-3.5 font-mono text-xs text-slate-500">{v.numero_control}</td>
                        <td className={`${td} whitespace-nowrap tabular-nums`}>{formatFecha(v.fecha)}</td>
                        <td className="px-5 py-3.5">
                          <span className={v.modalidad === "sin_dato" ? badgeNeutro : badgeMarca}>
                            {MODALIDAD_LABEL[v.modalidad]}
                          </span>
                        </td>
                        <td className={td}>{v.referencia ?? "—"}</td>
                        <td className={td}>
                          {v.metodo_pago ? METODO_LABEL[v.metodo_pago] ?? v.metodo_pago : "—"}
                        </td>
                        <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-slate-800">
                          <span className="inline-flex items-center gap-2">
                            {v.estado === "anulada" && <span className={badgeError}>Anulada</span>}
                            {formatGs(v.total)}
                          </span>
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
