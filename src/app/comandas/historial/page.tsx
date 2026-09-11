"use client";

import SelectField from "@/components/ui/SelectField";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { comandaPrintUrl, getComandasHistorial, reimprimirComanda } from "@/lib/comandas/storage";
import type { ComandaCard, EstadoComanda } from "@/lib/comandas/types";
import { SectorBadge } from "@/components/comandas/SectorBadge";

function formatFecha(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("es-PY", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
const input = "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-[#0EA5E9]";
const BADGE: Record<EstadoComanda, string> = {
  generada: "bg-amber-100 text-amber-700", impresa: "bg-emerald-100 text-emerald-700", cancelada: "bg-rose-100 text-rose-700",
};

export default function ComandasHistorialPage() {
  const [items, setItems] = useState<ComandaCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<Set<string>>(new Set());

  const [desde, setDesde] = useState(""); const [hasta, setHasta] = useState("");
  const [estado, setEstado] = useState<"impresa" | "cancelada" | "">("");
  const [mesa, setMesa] = useState(""); const [mozo, setMozo] = useState(""); const [numero, setNumero] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getComandasHistorial({
      desde: desde || null, hasta: hasta || null, estado: estado || null,
      mesa: mesa.trim() ? Number(mesa) : null, mozo: mozo.trim() || null,
      numero: numero.trim() ? Number(numero) : null,
    });
    setItems(data); setLoading(false);
  }, [desde, hasta, estado, mesa, mozo, numero]);
  useEffect(() => { void load(); }, [load]);

  function toggle(id: string) {
    setAbierto((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function onReimprimir(c: ComandaCard) {
    setError(null); setBusy(c.id);
    const w = window.open("about:blank", "_blank");
    const r = await reimprimirComanda(c.id);
    setBusy(null);
    if (!r.success) { try { w?.close(); } catch {} setError(r.error); return; }
    const href = comandaPrintUrl(c.id);
    try { if (w) w.location.href = href; else window.open(href, "_blank", "noopener"); } catch {}
    void load();
  }

  const hayFiltros = desde || hasta || estado || mesa || mozo || numero;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/comandas" className="text-xs text-[#0EA5E9] hover:underline">← Comandas</Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Historial de comandas</h1>
        <p className="mt-0.5 text-xs text-slate-500">Comandas impresas y canceladas. No afecta la cuenta de la mesa ni la facturación.</p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div><label className="block text-xs text-slate-600 mb-1">Desde</label><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={input} /></div>
          <div><label className="block text-xs text-slate-600 mb-1">Hasta</label><input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={input} /></div>
          <div><label className="block text-xs text-slate-600 mb-1">Estado</label>
            <SelectField value={estado} onChange={(e) => setEstado(e.target.value as "impresa" | "cancelada" | "")} className={input}>
              <option value="">Todas</option><option value="impresa">Impresa</option><option value="cancelada">Cancelada</option>
            </SelectField></div>
          <div className="w-24"><label className="block text-xs text-slate-600 mb-1">Mesa</label><input value={mesa} onChange={(e) => setMesa(e.target.value)} inputMode="numeric" placeholder="N°" className={`${input} w-24`} /></div>
          <div><label className="block text-xs text-slate-600 mb-1">Mozo</label><input value={mozo} onChange={(e) => setMozo(e.target.value)} placeholder="Nombre" className={input} /></div>
          <div className="w-28"><label className="block text-xs text-slate-600 mb-1">Comanda N°</label><input value={numero} onChange={(e) => setNumero(e.target.value)} inputMode="numeric" placeholder="N°" className={`${input} w-28`} /></div>
          {hayFiltros && (
            <button onClick={() => { setDesde(""); setHasta(""); setEstado(""); setMesa(""); setMozo(""); setNumero(""); }} className="px-2 py-2 text-sm text-slate-400 hover:text-slate-600">Limpiar</button>
          )}
        </div>

        {loading ? <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
          : items.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin comandas para los filtros elegidos.</p>
          : (
          <EdgeScrollArea>
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead><tr className="bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-3 py-2.5">Comanda</th><th className="px-3 py-2.5">Mesa</th><th className="px-3 py-2.5">Mozo</th>
                <th className="px-3 py-2.5">Creada</th><th className="px-3 py-2.5">Impresa</th><th className="px-3 py-2.5 text-center">Impresiones</th>
                <th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5 text-center">Acciones</th>
              </tr></thead>
              <tbody>
                {items.map((c) => {
                  const open = abierto.has(c.id);
                  const vigentes = c.items.filter((i) => !i.cancelado);
                  return (
                    <Fragment key={c.id}>
                      <tr className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2.5 font-semibold text-slate-800">N°{c.numero}<div><SectorBadge sector={c.sector} /></div></td>
                        <td className="px-3 py-2.5 tabular-nums">{c.mesa_numero ?? "—"}</td>
                        <td className="px-3 py-2.5">{c.mozo_nombre ?? "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{formatFecha(c.created_at)}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{formatFecha(c.printed_at)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums">{c.print_count}</td>
                        <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[c.estado]}`}>{c.estado}</span></td>
                        <td className="px-3 py-2.5">
                          <div className="flex justify-center gap-1">
                            <button onClick={() => toggle(c.id)} className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                              {open ? "Ocultar" : "Ver detalle"}
                            </button>
                            {c.estado === "impresa" && (
                              <button onClick={() => onReimprimir(c)} disabled={busy === c.id}
                                className="rounded bg-slate-700 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                                Reimprimir
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-slate-100 bg-slate-50/60">
                          <td colSpan={8} className="px-3 py-2.5">
                            <ul className="space-y-1">
                              {vigentes.map((it) => (
                                <li key={it.id} className="text-sm text-slate-700">
                                  <span className="font-semibold">{it.cantidad}×</span> {it.producto_nombre}
                                  {it.observacion && <span className="pl-2 text-xs text-amber-700">— {it.observacion}</span>}
                                </li>
                              ))}
                              {vigentes.length === 0 && <li className="text-xs text-slate-400">(sin ítems vigentes)</li>}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
