"use client";

import SelectField from "@/components/ui/SelectField";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { aprobarConciliacion, getConciliacion, rechazarConciliacion } from "@/lib/conciliacion/storage";
import type { ConciliacionEstado, ConciliacionResumen, ConciliacionRow, CuentaBancaria, MedioConciliacion } from "@/lib/conciliacion/types";

function formatGs(v: number) { return `Gs. ${Math.round(v).toLocaleString("es-PY")}`; }
function formatFecha(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("es-PY", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
const input = "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-[#0EA5E9]";
const BADGE: Record<ConciliacionEstado, string> = {
  pendiente: "bg-amber-100 text-amber-700", aprobado: "bg-emerald-100 text-emerald-700", rechazado: "bg-red-100 text-red-700",
};

export default function ConciliacionPage() {
  const [items, setItems] = useState<ConciliacionRow[]>([]);
  const [resumen, setResumen] = useState<ConciliacionResumen | null>(null);
  const [cuentas, setCuentas] = useState<CuentaBancaria[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [desde, setDesde] = useState(""); const [hasta, setHasta] = useState("");
  const [estado, setEstado] = useState<ConciliacionEstado | "">("");
  const [medio, setMedio] = useState<MedioConciliacion | "">("");
  const [cuenta, setCuenta] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const d = await getConciliacion({
      desde: desde || null, hasta: hasta || null, estado: estado || null,
      medio_pago: medio || null, cuenta_bancaria_id: cuenta || null,
    });
    setItems(d.items); setResumen(d.resumen); setCuentas(d.cuentas); setLoading(false);
  }, [desde, hasta, estado, medio, cuenta]);
  useEffect(() => { void load(); }, [load]);

  async function onAprobar(r: ConciliacionRow) {
    setError(null);
    const res = await aprobarConciliacion(r.id);
    if (!res.success) { setError(res.error); return; }
    void load();
  }
  async function onRechazar(r: ConciliacionRow) {
    const motivo = prompt(`Motivo del rechazo (${r.medio_pago} ${formatGs(r.monto)}):`) ?? "";
    if (motivo === null) return;
    setError(null);
    const res = await rechazarConciliacion(r.id, motivo);
    if (!res.success) { setError(res.error); return; }
    void load();
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reportes" className="text-xs text-[#0EA5E9] hover:underline">← Reportes</Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Conciliación bancaria</h1>
        <p className="mt-0.5 text-xs text-slate-500">Pagos por transferencia y tarjeta asociados a cajas y ventas.</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}

      {resumen && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Pendiente" value={formatGs(resumen.total_pendiente)} tone="amber" />
          <Stat label="Aprobado" value={formatGs(resumen.total_aprobado)} tone="emerald" />
          <Stat label="Rechazado" value={formatGs(resumen.total_rechazado)} tone="red" />
          <Stat label="Operaciones" value={String(resumen.cantidad)} />
          <Stat label="Transferencias" value={formatGs(resumen.transferencia_total)} />
          <Stat label="Tarjetas" value={formatGs(resumen.tarjeta_total)} />
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div><label className="block text-xs text-slate-600 mb-1">Desde</label><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={input} /></div>
          <div><label className="block text-xs text-slate-600 mb-1">Hasta</label><input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={input} /></div>
          <div><label className="block text-xs text-slate-600 mb-1">Estado</label>
            <SelectField value={estado} onChange={(e) => setEstado(e.target.value as ConciliacionEstado | "")} className={input}>
              <option value="">Todos</option><option value="pendiente">Pendiente</option><option value="aprobado">Aprobado</option><option value="rechazado">Rechazado</option>
            </SelectField></div>
          <div><label className="block text-xs text-slate-600 mb-1">Medio</label>
            <SelectField value={medio} onChange={(e) => setMedio(e.target.value as MedioConciliacion | "")} className={input}>
              <option value="">Todos</option><option value="transferencia">Transferencia</option><option value="tarjeta">Tarjeta</option>
            </SelectField></div>
          <div><label className="block text-xs text-slate-600 mb-1">Cuenta</label>
            <SelectField value={cuenta} onChange={(e) => setCuenta(e.target.value)} className={input}>
              <option value="">Todas</option>{cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </SelectField></div>
          {(desde || hasta || estado || medio || cuenta) && (
            <button onClick={() => { setDesde(""); setHasta(""); setEstado(""); setMedio(""); setCuenta(""); }} className="px-2 py-2 text-sm text-slate-400 hover:text-slate-600">Limpiar</button>
          )}
        </div>

        {loading ? <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
          : items.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin pagos para conciliar.</p>
          : (
          <EdgeScrollArea>
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead><tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-3 py-2.5">Fecha</th><th className="px-3 py-2.5">Venta</th><th className="px-3 py-2.5">Caja</th><th className="px-3 py-2.5">Mesa</th>
                <th className="px-3 py-2.5">Medio</th><th className="px-3 py-2.5">Cuenta / Titular</th><th className="px-3 py-2.5">Referencia</th>
                <th className="px-3 py-2.5 text-right">Monto</th><th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5 text-center">Acciones</th>
              </tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2.5 text-xs text-slate-500">{formatFecha(r.created_at)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{r.numero_control ?? "—"}</td>
                    <td className="px-3 py-2.5 tabular-nums">{r.caja_numero ?? "—"}</td>
                    <td className="px-3 py-2.5 tabular-nums">{r.mesa_numero ?? "—"}</td>
                    <td className="px-3 py-2.5">{r.medio_pago === "transferencia" ? "Transfer." : "Tarjeta"}{r.tipo_tarjeta ? ` (${r.tipo_tarjeta})` : ""}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {r.cuenta_nombre ?? "—"}
                      {/* El mismo campo guarda dos cosas distintas según el
                          medio: en transferencia es quién mandó la plata, en
                          tarjeta es por qué POS pasó. Etiquetarlo siempre como
                          "Titular" hacía leer "Titular: Bancard". */}
                      {r.entidad ? (
                        <span className="block text-[10px] text-slate-400">
                          {r.medio_pago === "tarjeta" ? "POS" : "Titular"}: {r.entidad}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{r.referencia ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{formatGs(r.monto)}</td>
                    <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[r.estado]}`}>{r.estado}</span>
                      {r.motivo_rechazo && <span className="block text-[10px] text-red-400">{r.motivo_rechazo}</span>}</td>
                    <td className="px-3 py-2.5 text-center">
                      {r.estado === "pendiente" ? (
                        <div className="flex justify-center gap-1">
                          <button onClick={() => onAprobar(r)} className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700">Aprobar</button>
                          <button onClick={() => onRechazar(r)} className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Rechazar</button>
                        </div>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: "amber" | "emerald" | "red" }) {
  const cls = tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : tone === "red" ? "text-red-700" : "text-slate-900";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-base font-bold tabular-nums ${cls}`}>{value}</p>
    </div>
  );
}
