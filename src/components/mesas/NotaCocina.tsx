"use client";

import { useEffect, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";

/**
 * Nota de cocina de un ítem del pedido ("sin aceitunas", "bien cocida").
 *
 * Vive acá y no dentro de cada pantalla porque Mesas y Para llevar muestran el
 * mismo pedido con el mismo comportamiento, y una nota que se guarda distinto
 * en cada una es una nota que en algún momento no sale impresa.
 *
 * Sólo se puede editar mientras el ítem está pendiente: una vez que la comanda
 * salió a cocina, cambiar el texto acá dejaría el papel que tiene el cocinero
 * diciendo otra cosa. Para eso está cancelar el ítem y volver a cargarlo.
 */

/** Atajos de lo que más se pide; se suman al texto, no lo reemplazan. */
const SUGERENCIAS = ["Sin aceitunas", "Sin cebolla", "Sin picante", "Para compartir"];

const LIMITE = 200;

export default function NotaCocina({
  valor,
  onGuardar,
  editable,
}: {
  valor: string | null;
  /** Guarda el texto; `null` borra la nota. Devuelve si se pudo guardar. */
  onGuardar: (texto: string | null) => Promise<boolean>;
  /** false cuando el ítem ya fue a cocina o la cuenta está en caja. */
  editable: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState(valor ?? "");
  const [guardando, setGuardando] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Si la nota cambia por fuera (otro dispositivo, recarga), el editor cerrado
  // tiene que reflejarlo; abierto no, para no pisarle lo que está escribiendo.
  useEffect(() => {
    if (!abierto) setTexto(valor ?? "");
  }, [valor, abierto]);

  useEffect(() => {
    if (abierto) areaRef.current?.focus();
  }, [abierto]);

  function agregarSugerencia(s: string) {
    setTexto((t) => {
      const base = t.trim();
      if (!base) return s;
      // Ya está escrita: no la duplica.
      if (base.toLowerCase().includes(s.toLowerCase())) return base;
      return `${base}, ${s}`.slice(0, LIMITE);
    });
    areaRef.current?.focus();
  }

  async function guardar(nuevo: string | null) {
    setGuardando(true);
    const ok = await onGuardar(nuevo);
    setGuardando(false);
    if (ok) setAbierto(false);
  }

  if (!editable) {
    // Sin permiso de edición la nota se sigue viendo, que es lo que importa
    // cuando la cuenta ya está en caja o el plato ya salió.
    return valor ? (
      <p className="mt-0.5 text-xs font-medium text-amber-700">— {valor}</p>
    ) : null;
  }

  if (!abierto) {
    return (
      <div className="mt-0.5">
        {valor && <p className="text-xs font-medium text-amber-700">— {valor}</p>}
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 active:scale-95"
        >
          <NotebookPen className="h-3.5 w-3.5" aria-hidden />
          {valor ? "Editar nota" : "Nota para cocina"}
        </button>
      </div>
    );
  }

  const limpio = texto.trim();

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-amber-800">
        Nota para cocina
      </label>
      <textarea
        ref={areaRef}
        value={texto}
        onChange={(e) => setTexto(e.target.value.slice(0, LIMITE))}
        rows={2}
        placeholder="Ej: sin aceitunas, bien cocida"
        className="w-full resize-none rounded-lg border border-amber-200 bg-white px-3 py-2 text-base text-slate-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200"
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGERENCIAS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => agregarSugerencia(s)}
            className="rounded-full border border-amber-200 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100 active:scale-95"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={guardando}
          onClick={() => void guardar(limpio || null)}
          className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-700 active:scale-95 disabled:opacity-50"
        >
          {guardando ? "Guardando…" : "Guardar"}
        </button>
        <button
          type="button"
          disabled={guardando}
          onClick={() => { setTexto(valor ?? ""); setAbierto(false); }}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
        >
          Cancelar
        </button>
        {valor && (
          <button
            type="button"
            disabled={guardando}
            onClick={() => void guardar(null)}
            className="ml-auto rounded-lg px-3 py-2.5 text-sm text-red-500 transition hover:text-red-700 disabled:opacity-50"
          >
            Quitar nota
          </button>
        )}
      </div>
    </div>
  );
}
