"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { getCajaDetalle } from "@/lib/caja/storage";
import type { CajaDetalle } from "@/lib/caja/types";
import { formatGs, formatFechaHora, metodoPagoLabel } from "@/lib/reportes/format";

const TIPO_MOV_LABEL: Record<string, string> = {
  ingreso: "Ingreso", egreso: "Egreso", retiro: "Retiro", ajuste: "Ajuste",
};

export default function CajaDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [det, setDet] = useState<CajaDetalle | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCajaDetalle(id).then((d) => {
      if (!cancelled) { setDet(d); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <p className="py-10 text-center text-sm text-slate-400">Cargando…</p>;
  if (!det) return (
    <div className="space-y-3">
      <Link href="/reportes/cierres-caja" className="text-xs text-[#0EA5E9] hover:underline">← Cierres de caja</Link>
      <p className="text-sm text-slate-500">Caja no encontrada.</p>
    </div>
  );

  const { resumen, ventas } = det;
  const c = resumen.caja;
  const dif = c.diferencia;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reportes/cierres-caja" className="text-xs text-[#0EA5E9] hover:underline">← Cierres de caja</Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
          Caja N° {c.numero_caja}
          <span className={`ml-2 rounded-full px-2 py-0.5 align-middle text-xs font-semibold ${c.estado === "abierta" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
            {c.estado === "abierta" ? "Abierta" : "Cerrada"}
          </span>
        </h1>
      </div>

      {/* Reimprimir: el arqueo sale solo al cerrar, pero el papel se pierde, se
          moja, o hace falta otra copia para la carpeta. */}
      <a
        href={`/api/caja/${c.id}/arqueo`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
      >
        Imprimir arqueo
      </a>

      {/* Resumen de caja */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Resumen de caja</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Apertura" value={formatFechaHora(c.fecha_apertura)} sub={resumen.abierta_por_nombre ?? "—"} />
          <Field label="Cierre" value={formatFechaHora(c.fecha_cierre)} sub={resumen.cerrada_por_nombre ?? "—"} />
          <Field label="Monto apertura" value={formatGs(c.monto_apertura)} />
          <Field label="Ventas" value={String(resumen.cantidad_ventas)} sub="cantidad" />
          <Field label="Total vendido" value={formatGs(resumen.total_vendido)} />
          <Field label="Efectivo" value={formatGs(resumen.total_efectivo)} />
          <Field label="Transferencia" value={formatGs(resumen.total_transferencia)} />
          <Field label="QR" value={formatGs(resumen.total_qr)} />
          <Field label="Tarjeta" value={formatGs(resumen.total_tarjeta)} />
          <Field label="Ingresos efvo." value={formatGs(resumen.ingresos_efectivo)} />
          <Field label="Egresos efvo." value={formatGs(resumen.egresos_efectivo)} />
          <Field label="Retiros efvo." value={formatGs(resumen.retiros_efectivo)} />
          <Field label="Debería haber en caja" value={formatGs(c.monto_esperado_efectivo ?? resumen.efectivo_esperado)} accent />
          <Field label="Efectivo contado" value={formatGs(c.monto_cierre_contado)} />
          <Field
            label="Diferencia"
            value={dif == null ? "—" : formatGs(dif)}
            tone={dif == null ? undefined : dif === 0 ? "ok" : dif > 0 ? "info" : "bad"}
          />
        </div>
        {(c.observacion_apertura || c.observacion_cierre) && (
          <div className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
            {c.observacion_apertura && <p><strong>Obs. apertura:</strong> {c.observacion_apertura}</p>}
            {c.observacion_cierre && <p><strong>Obs. cierre:</strong> {c.observacion_cierre}</p>}
          </div>
        )}
      </div>

      {/* Totales por medio de pago */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Totales por medio de pago</h2>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Efectivo" value={formatGs(resumen.total_efectivo)} />
          <Field label="Transferencia" value={formatGs(resumen.total_transferencia)} />
          <Field label="QR" value={formatGs(resumen.total_qr)} />
          <Field label="Tarjeta" value={formatGs(resumen.total_tarjeta)} />
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Transferencia y tarjeta cuentan como ventas, pero no como efectivo esperado.</p>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-4">
          <Field label="Transfer. pendiente" value={formatGs(det.conciliacion.transferencia_pendiente)} tone={det.conciliacion.transferencia_pendiente > 0 ? "info" : undefined} />
          <Field label="Transfer. aprobada" value={formatGs(det.conciliacion.transferencia_aprobada)} tone="ok" />
          <Field label="Tarjeta pendiente" value={formatGs(det.conciliacion.tarjeta_pendiente)} tone={det.conciliacion.tarjeta_pendiente > 0 ? "info" : undefined} />
          <Field label="Tarjeta aprobada" value={formatGs(det.conciliacion.tarjeta_aprobada)} tone="ok" />
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          <a href="/reportes/conciliacion-bancaria" className="text-[#0EA5E9] hover:underline">Ver conciliación bancaria →</a>
        </p>
      </div>

      {/* Movimientos de caja */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Movimientos de caja ({resumen.movimientos.length})</h2>
        {resumen.movimientos.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-400">Sin movimientos manuales.</p>
        ) : (
          <EdgeScrollArea>
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2">Concepto</th>
                  <th className="px-3 py-2">Medio</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {resumen.movimientos.map((m) => (
                  <tr key={m.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 text-xs text-slate-500">{formatFechaHora(m.created_at)}</td>
                    <td className="px-3 py-2">{TIPO_MOV_LABEL[m.tipo] ?? m.tipo}</td>
                    <td className="px-3 py-2">{m.concepto}</td>
                    <td className="px-3 py-2 text-xs">{metodoPagoLabel(m.medio_pago)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatGs(m.monto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </EdgeScrollArea>
        )}
      </div>

      {/* Ventas asociadas */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Ventas de esta caja ({ventas.length})</h2>
        {ventas.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-400">No hay ventas asociadas a esta caja.</p>
        ) : (
          <EdgeScrollArea>
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="px-3 py-2">N° control</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Ítems</th>
                  <th className="px-3 py-2">Pago</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {ventas.map((v) => (
                  <tr key={v.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{v.numero_control}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{formatFechaHora(v.fecha)}</td>
                    <td className="px-3 py-2 tabular-nums">{v.cantidad_items}</td>
                    <td className="px-3 py-2 text-xs">{metodoPagoLabel(v.metodo_pago)}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatGs(v.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </EdgeScrollArea>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, sub, accent, tone }: {
  label: string; value: string; sub?: string; accent?: boolean;
  tone?: "ok" | "info" | "bad";
}) {
  const toneCls = tone === "ok" ? "text-emerald-600" : tone === "info" ? "text-sky-600" : tone === "bad" ? "text-red-600" : "text-slate-900";
  return (
    <div className={`rounded-lg border p-2.5 ${accent ? "border-emerald-300 bg-emerald-100/60" : "border-slate-200 bg-white"}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-sm font-bold tabular-nums ${toneCls}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  );
}
