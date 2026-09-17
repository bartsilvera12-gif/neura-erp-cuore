"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { agregarAdicional, eliminarAdicional } from "@/lib/mesas/storage";
import type { SesionAdicional } from "@/lib/mesas/types";

interface Props {
  sesionId: string;
  adicionales: SesionAdicional[];
  /** Se llama cuando cambia la lista, para que la page refresque el total. */
  onCambio: (nuevos: SesionAdicional[]) => void;
  /** Desactiva los botones cuando la cuenta ya no admite cambios (facturada, cancelada). */
  bloqueado?: boolean;
}

const CHIPS = [5000, 10000, 15000, 20000];

function formatGs(n: number) { return `Gs. ${n.toLocaleString("es-PY")}`; }

/**
 * Cargos extra sobre una cuenta: chips rápidos (5k / 10k / 15k / 20k) + un
 * botón "Otro" para cualquier monto. Se muestra la lista de los ya cargados
 * con opción de quitar cada uno.
 */
export default function AdicionalesSesion({ sesionId, adicionales, onCambio, bloqueado = false }: Props) {
  const [otroAbierto, setOtroAbierto] = useState(false);
  const [otroTexto, setOtroTexto] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sumar(monto: number) {
    if (bloqueado || guardando) return;
    setError(null);
    setGuardando(true);
    const r = await agregarAdicional(sesionId, monto);
    setGuardando(false);
    if (!r.success) { setError(r.error); return; }
    onCambio([...adicionales, r.adicional]);
  }

  function confirmarOtro() {
    const n = Math.max(0, Math.round(Number(otroTexto.replace(/[^\d]/g, "")) || 0));
    if (n <= 0) { setError("Ingresá un monto mayor a 0."); return; }
    setOtroTexto("");
    setOtroAbierto(false);
    void sumar(n);
  }

  async function quitar(id: string) {
    if (bloqueado || guardando) return;
    setError(null);
    setGuardando(true);
    const r = await eliminarAdicional(sesionId, id);
    setGuardando(false);
    if (!r.success) { setError(r.error); return; }
    onCambio(adicionales.filter((a) => a.id !== id));
  }

  const total = adicionales.reduce((s, a) => s + a.monto, 0);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Adicionales</h3>
        {total > 0 && (
          <span className="text-sm font-semibold text-slate-700">{formatGs(total)}</span>
        )}
      </div>

      <p className="mb-2 text-xs text-slate-500">
        Cargo extra al pedido (cargo por servicio, adicional cocina, etc.). Se suma al total.
      </p>

      <div className="flex flex-wrap gap-2">
        {CHIPS.map((monto) => (
          <button
            key={monto}
            type="button"
            disabled={bloqueado || guardando}
            onClick={() => sumar(monto)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + {formatGs(monto)}
          </button>
        ))}
        <button
          type="button"
          disabled={bloqueado || guardando}
          onClick={() => setOtroAbierto((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            otroAbierto
              ? "border-emerald-500 bg-emerald-50 text-emerald-800"
              : "border-slate-200 bg-white text-slate-700 hover:border-emerald-400 hover:bg-emerald-50"
          }`}
        >
          <Plus className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          Otro
        </button>
      </div>

      {otroAbierto && (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={otroTexto}
            onChange={(e) => setOtroTexto(e.target.value)}
            placeholder="Ej: 12000"
            disabled={guardando}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmarOtro(); } }}
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
          />
          <button
            type="button"
            disabled={guardando}
            onClick={confirmarOtro}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Guardar
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}

      {adicionales.length > 0 && (
        <ul className="mt-3 space-y-1">
          {adicionales.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-sm">
              <span className="text-slate-700">
                {a.descripcion ? a.descripcion : "Adicional"}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-semibold tabular-nums text-slate-800">{formatGs(a.monto)}</span>
                <button
                  type="button"
                  disabled={bloqueado || guardando}
                  onClick={() => quitar(a.id)}
                  className="rounded p-1 text-red-500 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Quitar este adicional"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
