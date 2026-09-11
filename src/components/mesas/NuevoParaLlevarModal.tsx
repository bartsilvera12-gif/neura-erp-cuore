"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { crearParaLlevar } from "@/lib/mesas/storage";

/**
 * Alta de un pedido Para llevar: nombre del cliente y nota para cocina.
 *
 * Vive en un componente propio porque se crea desde dos lados —el tablero de
 * Para llevar y el salón de Mesas— y es el mismo acto: alguien llegó al
 * mostrador. Con una copia en cada pantalla, agregar un campo mañana obligaría
 * a acordarse de las dos.
 */
export interface NuevoParaLlevarModalProps {
  /** Se llama con el id de la sesión creada, para llevar al detalle del pedido. */
  onCreado: (sesionId: string) => void;
  onCerrar: () => void;
}

/**
 * Atajos de nota. Cubren casi todos los casos sin escribir, que en el mostrador
 * con gente esperando es la diferencia entre cargarla y no cargarla.
 */
const NOTAS_RAPIDAS = ["Delivery", "Retira en el local"];

const inputBase =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";

export default function NuevoParaLlevarModal({ onCreado, onCerrar }: NuevoParaLlevarModalProps) {
  const [nombre, setNombre] = useState("");
  const [nota, setNota] = useState("");
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function crear() {
    setError(null);
    setCreando(true);
    const r = await crearParaLlevar(nombre.trim() || null, nota.trim() || null);
    setCreando(false);
    if (!r.success) { setError(r.error); return; }
    onCreado(r.sesion.id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={() => !creando && onCerrar()}
    >
      {/* Mismo material que ConfirmDialog: borde, franja de marca y sombra
          profunda. Sin eso el modal se lee como un diálogo del navegador. */}
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/80 to-[#4FAEB2]/30"
        />
        <div className="px-5 pb-4 pt-5">
          <h3 className="text-lg font-bold text-slate-800">Nuevo Para llevar</h3>
          <p className="mt-1 text-sm text-slate-500">El correlativo PL se asigna solo.</p>

          <label className="mt-3 block text-xs font-medium text-slate-600">Nombre del cliente</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej: Ramón"
            maxLength={120}
            disabled={creando}
            autoFocus
            className={`mt-1 text-base ${inputBase}`}
            onKeyDown={(e) => { if (e.key === "Enter") void crear(); }}
          />

          {/* La nota sale impresa y recuadrada en la comanda: es lo que le dice
              a cocina si esto es delivery, y de eso depende que avisen a tiempo
              para llamar al repartidor. */}
          <label className="mt-3 block text-xs font-medium text-slate-600">Nota para cocina</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {NOTAS_RAPIDAS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={creando}
                onClick={() => setNota((v) => (v === n ? "" : n))}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  nota === n
                    ? "border-amber-500 bg-amber-50 text-amber-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Ej: delivery, retira 21:00"
            maxLength={200}
            disabled={creando}
            className={`mt-2 text-sm ${inputBase}`}
            onKeyDown={(e) => { if (e.key === "Enter") void crear(); }}
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
            disabled={creando}
            onClick={onCerrar}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/60 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={creando}
            onClick={() => void crear()}
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {creando ? "Creando…" : "Crear"}
          </button>
        </div>
      </div>
    </div>
  );
}
