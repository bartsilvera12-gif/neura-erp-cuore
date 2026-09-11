"use client";

import { confirmar } from "@/components/ui/ConfirmDialog";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import {
  cancelarComanda, comandaPrintUrl, comandasPrintUrl, getComandas, getComandasHistorial, imprimirComanda,
} from "@/lib/comandas/storage";
import type { ComandaCard } from "@/lib/comandas/types";
import { SectorBadge } from "@/components/comandas/SectorBadge";
import ImpresionAutomatica from "@/components/comandas/ImpresionAutomatica";

function formatHora(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("es-PY", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

export default function ComandasPage() {
  const [pendientes, setPendientes] = useState<ComandaCard[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [ultimasImpresas, setUltimasImpresas] = useState<ComandaCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Con la impresión automática encendida la pantalla es la que dispara el
  // papel: 15 segundos de espera se sienten en la cocina.
  const [autoActivo, setAutoActivo] = useState(false);

  // La pantalla operativa solo trae comandas pendientes (estado = generada).
  const load = useCallback(async () => {
    const [pend, hist] = await Promise.all([
      getComandas("generada"),
      getComandasHistorial({ estado: "impresa" }),
    ]);
    setPendientes(pend);
    setUltimasImpresas(hist.slice(0, 5));
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => { if (!cancelled) void load(); };
    run();
    const t = setInterval(run, autoActivo ? 6000 : 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [load, autoActivo]);


  // Imprimir: pre-abrimos la pestaña (gesto del usuario) y luego la apuntamos al
  // ticket, tras registrar la impresión en el server. La comanda pasa a `impresa`
  // y desaparece de pendientes en el próximo load.
  async function onImprimir(c: ComandaCard) {
    setError(null); setBusy(c.id);
    const w = window.open("about:blank", "_blank");
    const r = await imprimirComanda(c.id);
    setBusy(null);
    if (!r.success) { try { w?.close(); } catch {} setError(r.error); return; }
    const href = comandaPrintUrl(c.id);
    try { if (w) w.location.href = href; else window.open(href, "_blank", "noopener"); } catch {}
    void load();
  }

  /**
   * Imprime todas las pendientes de una vez, en un solo papel.
   *
   * Un pedido genera una comanda por sector, así que "imprimir lo que hay"
   * suele ser más de una. Apretar Imprimir en cada tarjeta con la cocina llena
   * es exactamente el tiempo que se quería ahorrar.
   */
  async function onImprimirTodas() {
    const lote = pendientesVisibles;
    if (lote.length === 0) return;
    setError(null); setBusy("todas");
    const w = window.open("about:blank", "_blank");
    const marcadas: string[] = [];
    for (const c of lote) {
      const r = await imprimirComanda(c.id);
      if (r.success) marcadas.push(c.id);
    }
    setBusy(null);
    if (marcadas.length === 0) {
      try { w?.close(); } catch {}
      setError("No se pudo registrar la impresión de ninguna comanda.");
      return;
    }
    if (marcadas.length < lote.length) {
      setError(`Se imprimen ${marcadas.length} de ${lote.length}: las otras ya no estaban pendientes.`);
    }
    const href = comandasPrintUrl(marcadas);
    try { if (w) w.location.href = href; else window.open(href, "_blank", "noopener"); } catch {}
    void load();
  }

  async function onCancelar(c: ComandaCard) {
    if (!(await confirmar(`¿Cancelar la comanda N°${c.numero} (Mesa ${c.mesa_numero ?? "?"})? No afecta la cuenta de la mesa.`))) return;
    setError(null); setBusy(c.id);
    const r = await cancelarComanda(c.id);
    setBusy(null);
    if (!r.success) { setError(r.error); return; }
    void load();
  }

  function ItemsList({ c }: { c: ComandaCard }) {
    // Los avisos no traen ítems: lo que hay que leer es qué cambió.
    if (c.tipo !== "pedido") {
      return (
        <ul className="mt-2 space-y-2 border-t border-slate-100 pt-2">
          {(c.aviso ?? []).map((l, i) => (
            <li key={i} className="text-sm">
              <p className={c.tipo === "cancelacion" ? "font-semibold text-red-700 line-through" : "text-slate-500 line-through"}>
                {l.antes}
              </p>
              {l.ahora && <p className="font-semibold text-slate-800">→ {l.ahora}</p>}
              {l.observacion && <p className="text-xs text-amber-700">— {l.observacion}</p>}
            </li>
          ))}
        </ul>
      );
    }
    const items = c.items.filter((i) => !i.cancelado);
    return (
      <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
        {items.map((it) => (
          <li key={it.id} className="text-sm text-slate-800">
            <span className="font-semibold">{it.cantidad}×</span> {it.producto_nombre}
            {it.observacion && <span className="block pl-5 text-xs text-amber-700">— {it.observacion}</span>}
          </li>
        ))}
      </ul>
    );
  }

  function Card({ c }: { c: ComandaCard }) {
    const vigentes = c.items.filter((i) => !i.cancelado).length;
    return (
      <div
        className={`rounded-xl border bg-white p-3 shadow-sm ${
          c.tipo === "cancelacion" ? "border-red-400"
          : c.tipo === "modificacion" ? "border-amber-500"
          : "border-amber-300"
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="text-base font-bold text-slate-800">Comanda N°{c.numero}</span>
          <span className="text-xs text-slate-400">{formatHora(c.created_at)}</span>
        </div>
        {/* Qué es esto para cocina: comida por preparar, un agregado a lo que ya
            está haciendo, o un aviso sobre algo que ya salió. */}
        {c.tipo === "cancelacion" ? (
          <span className="mt-1 inline-block rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
            Cancelación
          </span>
        ) : c.tipo === "modificacion" ? (
          <span className="mt-1 inline-block rounded-md bg-amber-500 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
            Modificación
          </span>
        ) : c.es_agregado ? (
          <span className="mt-1 inline-block rounded-md bg-[#4FAEB2] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
            Agregado
          </span>
        ) : null}
        <SectorBadge sector={c.sector} />
        {/* Para llevar tiene que gritar: se prepara para empaquetar y alguien lo
            espera o lo viene a buscar, no va a una mesa del salón. */}
        {c.sesion_tipo === "para_llevar" ? (
          <>
            <span className="mt-1 inline-block rounded-md bg-violet-600 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
              Para llevar
            </span>
            <p className="text-sm text-slate-600">
              <strong>{c.nombre_cliente?.trim() || `Pedido N°${c.numero_pl ?? "—"}`}</strong>
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-600">Mesa <strong>{c.mesa_numero ?? "—"}</strong> · Mozo: {c.mozo_nombre ?? "—"}</p>
        )}
        {c.sesion_observacion?.trim() ? (
          <p className="mt-0.5 text-xs font-medium text-violet-700">Nota: {c.sesion_observacion}</p>
        ) : null}
        <p className="text-xs text-slate-500">{vigentes} ítem(s)</p>

        {/* Qué hay que cocinar y cuántos, siempre a la vista. Antes esto estaba
            detrás de un botón "Ver detalle": la tarjeta decía "1 ítem(s)" y
            había que abrirla para enterarse de que eran DOS hamburguesas. En
            una cocina, un dato que exige un clic es un dato que no está. */}
        <ItemsList c={c} />

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => onImprimir(c)} disabled={busy === c.id}
            className="flex-1 rounded-lg bg-[#0EA5E9] px-3 py-2.5 text-sm font-semibold text-white hover:bg-[#0284C7] active:scale-95 disabled:opacity-50">
            Imprimir
          </button>
          <button type="button" onClick={() => onCancelar(c)} disabled={busy === c.id}
            className="rounded-lg border border-rose-200 px-3 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50">
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  /**
   * Comandas pendientes que coinciden con la búsqueda.
   *
   * Se busca también dentro de los productos: en la cocina la pregunta es
   * "¿dónde está la hamburguesa?", no el número de comanda.
   */
  const pendientesVisibles = useMemo(
    () =>
      pendientes.filter((c) =>
        coincideBusqueda(
          busqueda,
          c.numero,
          c.mesa_numero,
          c.mozo_nombre,
          c.nombre_cliente,
          c.numero_pl,
          c.items.map((i) => i.producto_nombre).join(" ")
        )
      ),
    [pendientes, busqueda]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Comandas</h1>
          <p className="text-sm text-slate-500">Imprimí las comandas pendientes y pasáselas a cocina. Se actualiza solo.</p>
        </div>
        <Link href="/comandas/historial"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
          Ver historial de comandas →
        </Link>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"><AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}</div>}

      {/* Busca también por producto: en la cocina se pregunta "¿dónde está la
          hamburguesa?", no "¿dónde está la comanda 47?". */}
      <BuscadorLista
        valor={busqueda}
        onChange={setBusqueda}
        placeholder="Buscar por mesa, mozo, N° de comanda o producto…"
        mostrando={pendientesVisibles.length}
        total={pendientes.length}
      />

      {loading ? (
        <p className="py-10 text-center text-slate-400">Cargando comandas…</p>
      ) : (
        <>
          <ImpresionAutomatica pendientes={pendientes} cargando={loading} onImpresa={load} onEstado={setAutoActivo} />

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-600">
                Comandas pendientes de imprimir <span className="ml-1 rounded-full bg-amber-100 px-2 text-xs text-amber-800">{pendientes.length}</span>
              </h2>
              {pendientesVisibles.length > 1 && (
                <button
                  type="button"
                  onClick={() => void onImprimirTodas()}
                  disabled={busy !== null}
                  className="rounded-lg bg-[#0EA5E9] px-3 py-2 text-sm font-semibold text-white hover:bg-[#0284C7] disabled:opacity-50"
                >
                  {busy === "todas" ? "Imprimiendo…" : `Imprimir las ${pendientesVisibles.length}`}
                </button>
              )}
            </div>
            {pendientes.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">No hay comandas pendientes de imprimir.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pendientesVisibles.map((c) => <Card key={c.id} c={c} />)}
              </div>
            )}
          </section>

          {/* Acceso secundario y colapsado a las últimas impresas (no ocupa la vista principal). */}
          {ultimasImpresas.length > 0 && (
            <details className="rounded-xl border border-slate-200 bg-slate-50/60">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-slate-600">
                Últimas impresas <span className="text-slate-400">({ultimasImpresas.length})</span>
                <span className="float-right text-xs text-[#0EA5E9]">ver detalle en historial →</span>
              </summary>
              <ul className="divide-y divide-slate-200 border-t border-slate-200">
                {ultimasImpresas.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="text-slate-700">
                      <strong>N°{c.numero}</strong> ·{" "}
                      {c.sesion_tipo === "para_llevar"
                        ? `Para llevar${c.nombre_cliente?.trim() ? ` · ${c.nombre_cliente}` : ""}`
                        : `Mesa ${c.mesa_numero ?? "—"} · ${c.mozo_nombre ?? "—"}`}
                    </span>
                    <span className="text-xs text-slate-400">
                      impresa {formatHora(c.printed_at)}{c.print_count > 1 ? ` · ${c.print_count} impresiones` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="px-4 py-2.5">
                <Link href="/comandas/historial" className="text-xs font-medium text-[#0EA5E9] hover:underline">Ver historial completo →</Link>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
