"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { confirmar } from "@/components/ui/ConfirmDialog";
import { useCallback, useEffect, useState, useMemo } from "react";
import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import NuevoParaLlevarModal from "@/components/mesas/NuevoParaLlevarModal";
import { useRouter } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { comandaPrintUrl, imprimirComanda } from "@/lib/comandas/storage";
import { cancelarPL, getParaLlevarActivas } from "@/lib/mesas/storage";
import type { ComandaCard } from "@/lib/comandas/types";
import type { ParaLlevarConResumen } from "@/lib/mesas/types";
import { SectorBadge } from "@/components/comandas/SectorBadge";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}
function formatPL(n: number | null | undefined): string {
  return `PL-${String(n ?? 0).padStart(3, "0")}`;
}
function formatHora(iso: string | null) {
  if (!iso) return "—";
  try {
    // Paraguay UTC-3 fija (tzdata del contenedor puede estar stale).
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const s = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(s.getUTCDate())}/${p(s.getUTCMonth() + 1)} ${p(s.getUTCHours())}:${p(s.getUTCMinutes())}`;
  } catch { return iso; }
}

async function fetchPedidosPL(estado?: string): Promise<ComandaCard[]> {
  try {
    const qs = estado ? `?estado=${encodeURIComponent(estado)}` : "";
    const res = await fetchWithSupabaseSession(`/api/pedidos-para-llevar${qs}`, { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; data?: { comandas: ComandaCard[] }; error?: string };
    if (!res.ok || !json.success) return [];
    return json.data?.comandas ?? [];
  } catch { return []; }
}

export default function PedidosParaLlevarPage() {
  const router = useRouter();
  const [pendientes, setPendientes] = useState<ComandaCard[]>([]);
  const [activos, setActivos] = useState<ParaLlevarConResumen[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  /**
   * Refresca la pantalla conservando lo último bueno.
   *
   * El refresco corre cada 15 segundos: si un fallo pasajero se pintara como
   * lista vacía, los pedidos en curso desaparecerían de la vista del mostrador
   * con la comida ya en cocina.
   */
  const load = useCallback(async () => {
    const [pend, act] = await Promise.all([fetchPedidosPL("generada"), getParaLlevarActivas()]);
    if (act === null) {
      setError("No se pudo actualizar. Se muestra la última información disponible.");
      setLoading(false);
      return;
    }
    setError(null);
    setPendientes(pend);
    setActivos(act);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => { if (!cancelled) void load(); };
    run();
    const t = setInterval(run, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [load]);


  /**
   * Cancela un pedido para llevar desde el tablero.
   *
   * Antes sólo se podía entrando al pedido, así que un PL abierto por error
   * —o uno que el cliente no pasó a retirar— se quedaba ocupando el tablero
   * para siempre. No borra la sesión: la marca cancelada, que es lo que ya
   * hacía la pantalla del pedido, y así queda el rastro de que existió.
   */
  async function onCancelar(pl: ParaLlevarConResumen) {
    const nro = formatPL(pl.sesion.numero_pl);
    const quien = pl.sesion.nombre_cliente ? ` de ${pl.sesion.nombre_cliente}` : "";
    const conItems =
      pl.items_count > 0
        ? ` Se descartan sus ${pl.items_count} producto(s) por ${formatGs(pl.total)}, que no se van a cobrar.`
        : " No tiene productos cargados.";
    const enCocina =
      pl.items_count > 0
        ? " Si ya se envió comanda, lo que esté en cocina no se cancela solo: avisá al sector."
        : "";

    const ok = await confirmar(
      `¿Cancelar el pedido ${nro}${quien}?${conItems}${enCocina} El pedido queda cancelado y sale del tablero; no se puede reabrir.`,
      { confirmLabel: "Cancelar pedido", cancelLabel: "Volver" }
    );
    if (!ok) return;

    setError(null);
    setBusy(pl.sesion.id);
    const r = await cancelarPL(pl.sesion.id);
    setBusy(null);
    if (!r.success) { setError(r.error); return; }
    // Sale de la lista sin esperar al refresco de 15s.
    setActivos((prev) => prev.filter((x) => x.sesion.id !== pl.sesion.id));
    void load();
  }

  async function onImprimir(c: ComandaCard) {
    setError(null); setBusy(c.id);
    const w = window.open("about:blank", "_blank");
    const r = await imprimirComanda(c.id);
    setBusy(null);
    if (!r.success) { try { w?.close(); } catch { /* ignore */ } setError(r.error); return; }
    const href = comandaPrintUrl(c.id);
    try { if (w) w.location.href = href; else window.open(href, "_blank", "noopener"); } catch { /* ignore */ }
    void load();
  }

  /** Pedidos abiertos que coinciden con la búsqueda. */
  const activosVisibles = useMemo(
    () =>
      activos.filter((pl) =>
        coincideBusqueda(busqueda, pl.sesion.numero_pl, pl.sesion.nombre_cliente, pl.mozo_nombre)
      ),
    [activos, busqueda]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Pedidos para llevar</h1>
          <p className="text-sm text-slate-500">Pedidos con retiro en mostrador. Se refresca cada 15s.</p>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="rounded-xl bg-[#4FAEB2] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#3F8E91] active:scale-95"
        >
          + Nuevo Para llevar
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}

      {/* En el mostrador se busca por el nombre del cliente —"el pedido de
          Ramón"— tanto como por el número. */}
      <BuscadorLista
        valor={busqueda}
        onChange={setBusqueda}
        placeholder="Buscar por N° de pedido, cliente o mozo…"
        mostrando={activosVisibles.length}
        total={activos.length}
      />

      {loading ? (
        <p className="py-10 text-center text-slate-400">Cargando…</p>
      ) : (
        <>
          {/* Sección: pedidos abiertos por el mozo (todavía sin comanda) */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">En preparación</h2>
              <span className="text-xs text-slate-500">{activos.length} activo(s)</span>
            </div>
            {activosVisibles.length === 0 ? (
              <p className="py-3 text-center text-sm text-slate-400">{busqueda.trim() ? "Ningún pedido coincide con la búsqueda." : "No hay pedidos abiertos."}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {activosVisibles.map((pl) => {
                  const { sesion, total, items_count, mozo_nombre } = pl;
                  return (
                    <li
                      key={sesion.id}
                      className="flex items-stretch gap-1 rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-[#4FAEB2]/50 hover:shadow-md"
                    >
                      <button
                        type="button"
                        onClick={() => router.push(`/mesas/pl/${sesion.id}`)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-l-xl p-3 text-left active:scale-[0.98]"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-800">{formatPL(sesion.numero_pl)}</span>
                            {sesion.estado === "por_cobrar" && (
                              <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">Por cobrar</span>
                            )}
                          </div>
                          {sesion.nombre_cliente && <p className="truncate text-xs text-slate-500">{sesion.nombre_cliente}</p>}
                          <p className="text-[11px] text-slate-400">
                            {items_count} ítem(s){mozo_nombre ? ` · ${mozo_nombre}` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-bold tabular-nums text-slate-800">{formatGs(total)}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onCancelar(pl)}
                        disabled={busy === sesion.id}
                        title={`Cancelar ${formatPL(sesion.numero_pl)}`}
                        aria-label={`Cancelar ${formatPL(sesion.numero_pl)}`}
                        className="flex w-11 shrink-0 items-center justify-center rounded-r-xl border-l border-slate-100 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-600 active:scale-95 disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Sección: comandas pendientes de imprimir (ya enviadas a cocina) */}
          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Comandas por imprimir</h2>
              <span className="text-xs text-slate-500">{pendientes.length} pendiente(s)</span>
            </div>
            {pendientes.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center">
                <p className="text-slate-400">No hay comandas pendientes.</p>
              </div>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pendientes.map((c) => {
                  const items = c.items.filter((i) => !i.cancelado);
                  return (
                    <li key={c.id} className="flex flex-col justify-between rounded-2xl border border-[#4FAEB2]/30 bg-white p-4 shadow-sm">
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="rounded-md bg-[#4FAEB2]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#2F6E71]">Para llevar</span>
                              <span className="font-bold tabular-nums text-slate-800">{formatPL(c.numero_pl)}</span>
                            </div>
                            {c.tipo === "cancelacion" ? (
                              <span className="mt-1 inline-block rounded-md bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                                Cancelación
                              </span>
                            ) : c.tipo === "modificacion" ? (
                              <span className="mt-1 inline-block rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                                Modificación
                              </span>
                            ) : c.es_agregado ? (
                              <span className="mt-1 inline-block rounded-md bg-[#4FAEB2] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                                Agregado
                              </span>
                            ) : null}
                            {c.nombre_cliente && <p className="mt-0.5 text-sm text-slate-600">{c.nombre_cliente}</p>}
                            <p className="text-xs text-slate-400">
                              N°{c.numero} · {formatHora(c.created_at)}
                              {c.mozo_nombre ? ` · ${c.mozo_nombre}` : ""}
                            </p>
                          </div>
                          {c.sector && <SectorBadge sector={c.sector} />}
                        </div>

                        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2">
                          {c.tipo !== "pedido" &&
                            (c.aviso ?? []).map((l, i) => (
                              <li key={`av${i}`} className="text-sm">
                                <p className={c.tipo === "cancelacion" ? "font-semibold text-red-700 line-through" : "text-slate-500 line-through"}>
                                  {l.antes}
                                </p>
                                {l.ahora && <p className="font-semibold text-slate-800">→ {l.ahora}</p>}
                                {l.observacion && <p className="text-xs text-amber-700">— {l.observacion}</p>}
                              </li>
                            ))}
                          {items.map((it) => (
                            <li key={it.id} className="text-sm text-slate-800">
                              <span className="font-semibold">{it.cantidad}×</span> {it.producto_nombre}
                              {it.es_mitad_mitad && it.mitad_1_nombre && it.mitad_2_nombre && (
                                <span className="block pl-5 text-xs text-amber-700">½ {it.mitad_1_nombre} + ½ {it.mitad_2_nombre}</span>
                              )}
                              {it.observacion && <span className="block pl-5 text-xs text-amber-700">— {it.observacion}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <button
                        type="button"
                        onClick={() => onImprimir(c)}
                        disabled={busy === c.id}
                        className="mt-4 w-full rounded-xl bg-[#4FAEB2] px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-[#3F8E91] active:scale-95 disabled:opacity-50"
                      >
                        {busy === c.id ? "Imprimiendo…" : "Imprimir"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      {/* Modal Nuevo Para llevar */}
      {modalOpen && (
        <NuevoParaLlevarModal
          onCerrar={() => setModalOpen(false)}
          onCreado={(sesionId) => {
            setModalOpen(false);
            router.push(`/mesas/pl/${sesionId}`);
          }}
        />
      )}
    </div>
  );
}
