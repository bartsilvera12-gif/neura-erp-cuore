"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Percent, X } from "lucide-react";
import MontoInput from "@/components/ui/MontoInput";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { descuentoDesdePorcentaje } from "@/lib/ventas/descuento";

/**
 * Aplicar un descuento al cobro, con clave.
 *
 * Un descuento es plata que se deja de cobrar. Se pide clave no por
 * desconfianza sino porque tiene que quedar claro que alguien lo autorizó: la
 * venta guarda cuánto se descontó y por qué, y sin eso el arqueo del turno
 * cierra corto sin explicación y no se distingue de un faltante.
 *
 * La clave se valida en el servidor y no vuelve al navegador. Acá sólo se sabe
 * si quedó autorizado.
 */
export interface DescuentoAplicado {
  /** Monto en guaraníes. */
  monto: number;
  motivo: string | null;
  /**
   * Se conserva para mandarla con el cobro: el servidor la vuelve a validar al
   * crear la venta, porque autorizar y cobrar son dos llamadas distintas y la
   * segunda no puede confiar en que la primera ocurrió.
   *
   * Queda sólo en memoria de la pantalla, mientras dura el cobro.
   */
  clave: string;
}

export interface AplicarDescuentoProps {
  /** Total de la cuenta antes del descuento. */
  total: number;
  valor: DescuentoAplicado | null;
  onChange: (d: DescuentoAplicado | null) => void;
}

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-[#0EA5E9] focus:ring-2 focus:ring-[#0EA5E9]/20";

export default function AplicarDescuento({ total, valor, onChange }: AplicarDescuentoProps) {
  const [disponible, setDisponible] = useState<boolean | null>(null);
  const [maxPorcentaje, setMaxPorcentaje] = useState(100);
  const [abierto, setAbierto] = useState(false);

  const [modo, setModo] = useState<"porcentaje" | "monto">("porcentaje");
  const [porcentaje, setPorcentaje] = useState("");
  const [monto, setMonto] = useState(0);
  const [motivo, setMotivo] = useState("");
  const [clave, setClave] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validando, setValidando] = useState(false);

  useEffect(() => {
    let vivo = true;
    void fetchWithSupabaseSession("/api/ventas/descuento/autorizar")
      .then((r) => r.json())
      .then((j) => {
        if (!vivo) return;
        setDisponible(Boolean(j?.data?.configurada));
        setMaxPorcentaje(Number(j?.data?.maxPorcentaje) || 100);
      })
      .catch(() => { if (vivo) setDisponible(false); });
    return () => { vivo = false; };
  }, []);

  const montoCalculado =
    modo === "porcentaje" ? descuentoDesdePorcentaje(total, parseFloat(porcentaje) || 0) : Math.round(monto);
  const tope = descuentoDesdePorcentaje(total, maxPorcentaje);

  function cerrar() {
    setAbierto(false);
    setClave("");
    setError(null);
  }

  async function confirmar() {
    setError(null);
    if (montoCalculado <= 0) { setError("El descuento tiene que ser mayor a cero."); return; }
    if (montoCalculado >= total) { setError("El descuento no puede ser igual o mayor al total."); return; }
    if (montoCalculado > tope) {
      setError(`El tope autorizado es ${maxPorcentaje}% (${formatGs(tope)}).`);
      return;
    }

    setValidando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/ventas/descuento/autorizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clave }),
      });
      const j = await res.json();
      if (!res.ok || j?.success === false) {
        setError(j?.error ?? "No se pudo autorizar.");
        return;
      }
      onChange({ monto: montoCalculado, motivo: motivo.trim() || null, clave });
      cerrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setValidando(false);
    }
  }

  // Sin clave cargada no se ofrece el botón: prometer algo que después pide una
  // clave que nadie configuró es peor que no ofrecerlo.
  if (disponible !== true) return null;

  if (valor) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
        <p className="text-xs text-emerald-800">
          Descuento aplicado: <strong>{formatGs(valor.monto)}</strong>
          {valor.motivo ? ` · ${valor.motivo}` : ""}
        </p>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800 hover:underline"
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Quitar
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
      >
        <Percent className="h-3.5 w-3.5" aria-hidden />
        Aplicar descuento
      </button>

      {abierto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => !validando && cerrar()}
        >
          <div
            className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-400 via-amber-400/80 to-amber-400/30"
            />
            <div className="px-5 pb-4 pt-5">
              <h3 className="text-lg font-bold text-slate-800">Aplicar descuento</h3>
              <p className="mt-1 text-sm text-slate-500">
                Sobre {formatGs(total)}. Tope autorizado: {maxPorcentaje}%.
              </p>

              <div className="mt-3 flex gap-2">
                {(["porcentaje", "monto"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModo(m)}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      modo === m
                        ? "border-amber-500 bg-amber-50 text-amber-800"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {m === "porcentaje" ? "Por porcentaje" : "Por monto"}
                  </button>
                ))}
              </div>

              {modo === "porcentaje" ? (
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-slate-600">Porcentaje</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={maxPorcentaje}
                    value={porcentaje}
                    onChange={(e) => setPorcentaje(e.target.value)}
                    placeholder={`Ej: 10`}
                    autoFocus
                    className={inputClass}
                  />
                </div>
              ) : (
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-slate-600">Monto a descontar</label>
                  <MontoInput value={monto} onChange={setMonto} placeholder="Ej: 5.000" />
                </div>
              )}

              {/* El total con descuento se muestra antes de confirmar: el cajero
                  tiene que ver el número que le va a cobrar al cliente, no
                  deducirlo de un porcentaje. */}
              {montoCalculado > 0 && (
                <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex justify-between text-slate-600">
                    <span>Descuento</span>
                    <span className="tabular-nums font-medium">− {formatGs(montoCalculado)}</span>
                  </div>
                  <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-bold text-slate-900">
                    <span>Total a cobrar</span>
                    <span className="tabular-nums">{formatGs(Math.max(0, total - montoCalculado))}</span>
                  </div>
                </div>
              )}

              <label className="mt-3 block text-xs font-medium text-slate-600">Motivo</label>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej: cliente frecuente, producto demorado"
                maxLength={200}
                className={`mt-1 ${inputClass}`}
              />

              <label className="mt-3 block text-xs font-medium text-slate-600">Clave de autorización</label>
              <input
                type="password"
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                placeholder="Clave"
                autoComplete="off"
                className={`mt-1 ${inputClass}`}
                onKeyDown={(e) => { if (e.key === "Enter") void confirmar(); }}
              />

              {error && (
                <p className="mt-2 text-sm text-red-600">
                  <AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
              <button
                type="button"
                disabled={validando}
                onClick={cerrar}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/60 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={validando}
                onClick={() => void confirmar()}
                className="rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
              >
                {validando ? "Autorizando…" : "Aplicar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
