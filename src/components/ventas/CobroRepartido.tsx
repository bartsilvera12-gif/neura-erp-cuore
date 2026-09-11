"use client";

import { Plus, Trash2 } from "lucide-react";
import MontoInput from "@/components/ui/MontoInput";
import type { MetodoPago } from "@/lib/ventas/types";

/**
 * Reparto del cobro de una venta entre varias formas de pago.
 *
 * Arranca con una sola línea por el total, que es como se cobra casi siempre:
 * el cajero toca el método y listo. Recién cuando el cliente paga una parte en
 * efectivo y otra por transferencia hace falta agregar una segunda línea.
 *
 * Importa que cierre: el arqueo calcula el efectivo esperado sumando lo cobrado
 * por método, así que una línea mal cargada aparece como faltante de caja al
 * final del turno, cuando ya nadie se acuerda de esa venta.
 */

export interface LineaCobro {
  key: string;
  metodo: MetodoPago;
  /** Texto crudo del input; se convierte a número al enviar. */
  monto: string;
}

const METODOS: Array<{ v: MetodoPago; label: string }> = [
  { v: "efectivo", label: "Efectivo" },
  { v: "tarjeta", label: "Tarjeta" },
  { v: "transferencia", label: "Transfer." },
  { v: "qr", label: "QR" },
];

export function montoDeLinea(l: LineaCobro): number {
  return parseFloat(String(l.monto).replace(",", ".")) || 0;
}

export function totalCobrado(lineas: LineaCobro[]): number {
  return lineas.reduce((acc, l) => acc + montoDeLinea(l), 0);
}

/**
 * Sólo se exige que cierre cuando el cobro está repartido. Con una sola forma
 * de pago el monto se completa solo con el total, y el cajero puede además
 * anotar cuánto recibió para ver el vuelto sin que eso descuadre nada.
 */
export function cobroValido(lineas: LineaCobro[], total: number): boolean {
  if (lineas.length <= 1) return true;
  return Math.abs(totalCobrado(lineas) - total) <= 1;
}

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

export default function CobroRepartido({
  lineas,
  onChange,
  total,
  inputClass,
}: {
  lineas: LineaCobro[];
  onChange: (l: LineaCobro[]) => void;
  total: number;
  inputClass: string;
}) {
  const repartido = lineas.length > 1;
  const cobrado = totalCobrado(lineas);
  const falta = total - cobrado;

  function setLinea(key: string, parcial: Partial<LineaCobro>) {
    onChange(lineas.map((l) => (l.key === key ? { ...l, ...parcial } : l)));
  }

  function agregar() {
    // La línea nueva arranca con lo que falta para llegar al total: es lo que
    // el cajero va a escribir el 90% de las veces.
    const restante = Math.max(0, total - cobrado);
    const usados = new Set(lineas.map((l) => l.metodo));
    const libre = METODOS.find((m) => !usados.has(m.v))?.v ?? "efectivo";
    onChange([
      ...lineas,
      { key: `p${Date.now()}`, metodo: libre, monto: restante > 0 ? String(restante) : "" },
    ]);
  }

  function quitar(key: string) {
    const quedan = lineas.filter((l) => l.key !== key);
    // Al volver a una sola forma de pago, el monto deja de importar: lo cubre
    // el total de la venta.
    onChange(quedan.length === 1 ? [{ ...quedan[0], monto: String(total) }] : quedan);
  }

  return (
    <div className="space-y-2">
      {lineas.map((l, i) => (
        <div key={l.key} className="space-y-1.5">
          <div className="grid grid-cols-4 gap-1">
            {METODOS.map((m) => (
              <button
                key={m.v}
                type="button"
                onClick={() => setLinea(l.key, { metodo: m.v })}
                className={`rounded-md border py-1.5 text-xs transition-colors ${
                  l.metodo === m.v
                    ? "border-[#4FAEB2] bg-[#4FAEB2]/10 font-semibold text-[#3F8E91]"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {repartido && (
            <div className="flex items-center gap-1.5">
              <MontoInput
                value={l.monto}
                onChange={(n) => setLinea(l.key, { monto: String(n) })}
                placeholder="Monto"
                className={inputClass}
                decimals={false}
              />
              <button
                type="button"
                onClick={() => quitar(l.key)}
                className="shrink-0 rounded-md p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                aria-label={`Quitar forma de pago ${i + 1}`}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}
        </div>
      ))}

      {lineas.length < METODOS.length && (
        <button
          type="button"
          onClick={agregar}
          className="w-full rounded-md border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:border-[#4FAEB2] hover:text-[#3F8E91]"
        >
          <Plus className="mr-1 inline h-3.5 w-3.5 align-[-0.125em]" aria-hidden />
          Pagó con más de una forma
        </button>
      )}

      {repartido && (
        <div className="flex justify-between border-t border-slate-200 pt-2 text-xs">
          <span className="text-slate-600">Cobrado</span>
          <span
            className={`font-bold tabular-nums ${
              Math.abs(falta) <= 1 ? "text-emerald-600" : "text-amber-700"
            }`}
          >
            {formatGs(cobrado)}
            {Math.abs(falta) > 1 && (
              <span className="ml-1.5 font-normal">
                ({falta > 0 ? `faltan ${formatGs(falta)}` : `sobran ${formatGs(-falta)}`})
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
