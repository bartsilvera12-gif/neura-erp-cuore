"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import BuscadorLista, { coincideBusqueda } from "@/components/ui/BuscadorLista";
import { confirmar } from "@/components/ui/ConfirmDialog";
import { cancelarMesa, cancelarPL, getMesasPorCobrar } from "@/lib/mesas/storage";
import type { MesaConResumen } from "@/lib/mesas/types";

function formatGs(v: number) { return `Gs. ${Math.round(v).toLocaleString("es-PY")}`; }

/**
 * Cómo se llama la cuenta en la lista.
 *
 * Acá ahora conviven mesas y pedidos Para llevar. Un Para llevar no tiene mesa,
 * así que mostrarlo como "Mesa 0" —lo que pasaba— no le dice nada al cajero:
 * lleva su número de pedido y, si lo dieron, el nombre del cliente.
 */
function titulo(m: MesaConResumen): string {
  if (m.sesion?.tipo === "para_llevar") {
    const nro = `PL-${String(m.sesion.numero_pl ?? 0).padStart(3, "0")}`;
    return m.sesion.nombre_cliente ? `${nro} · ${m.sesion.nombre_cliente}` : nro;
  }
  return `Mesa ${m.mesa.numero}`;
}

export default function MesasPorCobrarPage() {
  const [mesas, setMesas] = useState<MesaConResumen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");

  const load = useCallback(async () => {
    const d = await getMesasPorCobrar();
    setMesas(d);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Saca una mesa del tablero sin cobrarla.
   *
   * Hacía falta porque una mesa abierta por error —o una que se levantó sin
   * consumir— se quedaba acá para siempre, y encima cuenta como pendiente en el
   * arqueo del turno. No borra nada: la cuenta queda marcada como cancelada, así
   * que el rastro de que existió no se pierde.
   *
   * El aviso cambia según lo que se esté descartando. No es lo mismo cerrar una
   * mesa vacía que una con Gs. 45.000 cargados: en el segundo caso el texto dice
   * cuánto se está tirando, porque una vez hecho no se puede reabrir.
   */
  async function onCancelar(m: MesaConResumen) {
    const conItems =
      m.items_count > 0
        ? ` Se descartan sus ${m.items_count} producto(s) por ${formatGs(m.total)}, que no se van a cobrar.`
        : " No tiene productos cargados.";
    const enCocina =
      m.items_count > 0
        ? " Si ya se envió comanda, lo que esté en cocina no se cancela solo: avisá al sector."
        : "";

    const esPL = m.sesion?.tipo === "para_llevar";
    const ok = await confirmar(
      `¿Cancelar ${esPL ? `el pedido ${titulo(m)}` : `la cuenta de la Mesa ${m.mesa.numero}`}?${conItems}${enCocina} Sale de esta lista y no se puede reabrir.`,
      { confirmLabel: "Cancelar cuenta", cancelLabel: "Volver" }
    );
    if (!ok) return;

    setError(null);
    setBusy(m.sesion!.id);
    // Un Para llevar no tiene mesa que liberar, así que se cancela por sesión.
    const r = esPL ? await cancelarPL(m.sesion!.id) : await cancelarMesa(m.mesa.id);
    setBusy(null);
    if (!r.success) { setError(r.error); return; }
    // Sale de la lista en el momento, sin esperar la recarga.
    setMesas((prev) => prev.filter((x) => x.sesion?.id !== m.sesion?.id));
    void load();
  }

  /** Cuentas que coinciden con la búsqueda: mesas y Para llevar. */
  const visibles = useMemo(
    () =>
      mesas.filter((m) =>
        coincideBusqueda(
          busqueda,
          m.mesa.numero,
          m.mesa.nombre,
          m.sesion?.numero_pl,
          m.sesion?.nombre_cliente,
          m.mozo_nombre
        )
      ),
    [mesas, busqueda]
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href="/ventas" className="text-xs text-[#0EA5E9] hover:underline">← Caja</Link>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Por cobrar</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Mesas y pedidos Para llevar esperando cobro. Tocá uno para cobrarlo: buscador de productos, edición de la cuenta y cobro en la misma pantalla.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
          {error}
        </div>
      )}

      <BuscadorLista
        valor={busqueda}
        onChange={setBusqueda}
        placeholder="Buscar por mesa, N° de pedido, cliente o mozo…"
        mostrando={visibles.length}
        total={mesas.length}
      />

      {loading ? (
        <p className="py-10 text-center text-slate-400">Cargando…</p>
      ) : visibles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-12 text-center text-slate-400">
          {busqueda.trim() ? "Nada coincide con la búsqueda." : "No hay nada por cobrar."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visibles.map((m) => m.sesion && (
            <div
              key={m.sesion.id}
              className="rounded-xl border border-rose-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-2xl font-extrabold text-slate-800">{titulo(m)}</p>
                  <p className="text-xs text-slate-500">Mozo: {m.mozo_nombre ?? "—"} · {m.items_count} ítem(s)</p>
                </div>
                <div className="flex items-start gap-2">
                  <p className="text-2xl font-extrabold tabular-nums text-slate-900">{formatGs(m.total)}</p>
                  {/* Cancelar queda apartado del botón de cobrar y sin color de
                      alarma: es una salida disponible, no la acción esperada. */}
                  <button
                    type="button"
                    onClick={() => void onCancelar(m)}
                    disabled={busy === m.sesion.id}
                    title={`Cancelar ${titulo(m)}`}
                    aria-label={`Cancelar ${titulo(m)}`}
                    className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-red-50 hover:text-red-600 active:scale-95 disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Link
                  href={`/ventas/mesas-por-cobrar/${m.sesion.id}`}
                  className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
                >
                  Cobrar →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
