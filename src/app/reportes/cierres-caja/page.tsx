"use client";

import SelectField from "@/components/ui/SelectField";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { getCierresCaja } from "@/lib/caja/storage";
import type { CajaResumen } from "@/lib/caja/types";
import { formatGs, formatFechaHora } from "@/lib/reportes/format";

type FiltroEstado = "todas" | "abierta" | "cerrada";

const inputClass = "border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0EA5E9] bg-white";

export default function CierresCajaPage() {
  const [cajas, setCajas] = useState<CajaResumen[]>([]);
  const [loading, setLoading] = useState(true);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [estado, setEstado] = useState<FiltroEstado>("todas");

  useEffect(() => {
    let cancelled = false;
    getCierresCaja().then((d) => {
      if (!cancelled) { setCajas(d); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  const filtradas = useMemo(() => {
    const dStart = desde ? new Date(`${desde}T00:00:00`) : null;
    const dEnd = hasta ? new Date(`${hasta}T23:59:59.999`) : null;
    return cajas.filter((c) => {
      if (estado !== "todas" && c.caja.estado !== estado) return false;
      // Filtro por fecha de APERTURA (el turno puede cruzar medianoche; se agrupa por caja).
      const f = new Date(c.caja.fecha_apertura);
      if (dStart && f < dStart) return false;
      if (dEnd && f > dEnd) return false;
      return true;
    });
  }, [cajas, desde, hasta, estado]);

  const hayFiltros = desde || hasta || estado !== "todas";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reportes" className="text-xs text-[#0EA5E9] hover:underline">← Reportes</Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Cierres de caja</h1>
        <p className="mt-0.5 text-xs text-slate-500">Aperturas, cierres, movimientos y diferencias por turno.</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        {/* Filtros */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Desde</label>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Hasta</label>
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Estado</label>
            <SelectField value={estado} onChange={(e) => setEstado(e.target.value as FiltroEstado)} className={inputClass}>
              <option value="todas">Todas</option>
              <option value="abierta">Abierta</option>
              <option value="cerrada">Cerrada</option>
            </SelectField>
          </div>
          {hayFiltros && (
            <button onClick={() => { setDesde(""); setHasta(""); setEstado("todas"); }} className="px-2 py-2 text-sm text-slate-400 hover:text-slate-600">
              Limpiar
            </button>
          )}
          <span className="ml-auto text-sm text-slate-400">{filtradas.length} de {cajas.length} cajas</span>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
        ) : filtradas.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">No hay cajas para los filtros seleccionados.</p>
        ) : (
          <EdgeScrollArea>
            <table className="w-full min-w-[1200px] text-left text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-3 py-2.5">N°</th>
                  <th className="px-3 py-2.5">Estado</th>
                  <th className="px-3 py-2.5">Apertura</th>
                  <th className="px-3 py-2.5">Cierre</th>
                  <th className="px-3 py-2.5 text-right">Apertura Gs</th>
                  <th className="px-3 py-2.5 text-right">Vendido</th>
                  <th className="px-3 py-2.5 text-right">Efectivo</th>
                  <th className="px-3 py-2.5 text-right">Transfer.</th>
                  <th className="px-3 py-2.5 text-right">Tarjeta</th>
                  <th className="px-3 py-2.5 text-right">Esperado</th>
                  <th className="px-3 py-2.5 text-right">Contado</th>
                  <th className="px-3 py-2.5 text-right">Diferencia</th>
                  <th className="px-3 py-2.5 text-center">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {filtradas.map((c) => {
                  const dif = c.caja.diferencia;
                  const esperado = c.caja.monto_esperado_efectivo ?? (c.caja.estado === "abierta" ? c.efectivo_esperado : null);
                  return (
                    <tr key={c.caja.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-medium tabular-nums">{c.caja.numero_caja}</td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${c.caja.estado === "abierta" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                          {c.caja.estado === "abierta" ? "Abierta" : "Cerrada"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        {formatFechaHora(c.caja.fecha_apertura)}
                        <span className="block text-[11px] text-slate-400">{c.abierta_por_nombre ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        {formatFechaHora(c.caja.fecha_cierre)}
                        <span className="block text-[11px] text-slate-400">{c.cerrada_por_nombre ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatGs(c.caja.monto_apertura)}</td>
                      <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatGs(c.total_vendido)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatGs(c.total_efectivo)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatGs(c.total_transferencia)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatGs(c.total_tarjeta)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatGs(esperado)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatGs(c.caja.monto_cierre_contado)}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${dif == null ? "text-slate-400" : dif === 0 ? "text-emerald-600" : dif > 0 ? "text-sky-600" : "text-red-600"}`}>
                        {dif == null ? "—" : formatGs(dif)}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <Link href={`/reportes/cierres-caja/${c.caja.id}`} className="text-xs font-medium text-[#0EA5E9] hover:underline">
                          Ver detalle
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </EdgeScrollArea>
        )}
      </div>
    </div>
  );
}
