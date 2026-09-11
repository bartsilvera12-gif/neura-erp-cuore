"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getEstadoCuenta } from "@/lib/caja/storage";
import type { EstadoCuentaLomiteria } from "@/lib/caja/types";
import { formatGs } from "@/lib/reportes/format";

const inputClass = "border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0EA5E9] bg-white";

export default function EstadoCuentaPage() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [data, setData] = useState<EstadoCuentaLomiteria | null>(null);
  const [loading, setLoading] = useState(true);

  const cargar = useCallback(async () => {
    setLoading(true);
    setData(await getEstadoCuenta(desde || null, hasta || null));
    setLoading(false);
  }, [desde, hasta]);

  useEffect(() => { void cargar(); }, [cargar]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reportes" className="text-xs text-[#0EA5E9] hover:underline">← Reportes</Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Estado de cuenta de la lomitería</h1>
        <p className="mt-0.5 text-xs text-slate-500">Resumen financiero por cajas cerradas (agrupado por turno, no por fecha calendario).</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Desde (cierre)</label>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Hasta (cierre)</label>
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={inputClass} />
          </div>
          {(desde || hasta) && (
            <button onClick={() => { setDesde(""); setHasta(""); }} className="px-2 py-2 text-sm text-slate-400 hover:text-slate-600">
              Todo el historial
            </button>
          )}
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
        ) : !data ? (
          <p className="py-8 text-center text-sm text-slate-400">No se pudo cargar el estado de cuenta.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Stat label="Cajas cerradas" value={String(data.cajas_cerradas)} />
              <Stat label="Total vendido" value={formatGs(data.total_vendido)} accent />
              <Stat label="Promedio por caja" value={formatGs(data.promedio_vendido)} />
              <Stat label="Neto estimado" value={formatGs(data.neto_estimado)} sub="vendido − egresos − retiros" accent />
              <Stat label="Total efectivo" value={formatGs(data.total_efectivo)} />
              <Stat label="Total transferencia" value={formatGs(data.total_transferencia)} />
              <Stat label="Total QR" value={formatGs(data.total_qr)} />
              <Stat label="Total tarjeta" value={formatGs(data.total_tarjeta)} />
              <Stat label="Total egresos" value={formatGs(data.total_egresos)} />
              <Stat label="Total retiros" value={formatGs(data.total_retiros)} />
              <Stat
                label="Diferencias acumuladas"
                value={formatGs(data.diferencias_acumuladas)}
                tone={data.diferencias_acumuladas === 0 ? "ok" : data.diferencias_acumuladas > 0 ? "info" : "bad"}
              />
            </div>
            {data.cajas_cerradas === 0 && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-800">
                No hay cajas cerradas en el rango seleccionado.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent, tone }: {
  label: string; value: string; sub?: string; accent?: boolean; tone?: "ok" | "info" | "bad";
}) {
  const toneCls = tone === "ok" ? "text-emerald-600" : tone === "info" ? "text-sky-600" : tone === "bad" ? "text-red-600" : "text-slate-900";
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-emerald-300 bg-emerald-100/60" : "border-slate-200 bg-white"}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-base font-bold tabular-nums ${toneCls}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  );
}
