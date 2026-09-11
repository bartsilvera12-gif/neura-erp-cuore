"use client";

import { Pizza, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getIngredientesCatalogo } from "@/lib/mesas/storage";

interface Ingrediente {
  id: string;
  nombre: string;
  precio: number;
}

export interface PersonalizarPizzaResult {
  cantidad: number;
  observacion: string | null;
  ingredientes_agregar: string[];
  ingredientes_quitar: string[];
}

interface Props {
  open: boolean;
  productoNombre: string;
  onClose: () => void;
  onConfirm: (r: PersonalizarPizzaResult) => void;
}

/**
 * Modal para personalizar una pizza antes de sumarla al pedido: qué agregar,
 * qué quitar, cuántas unidades y una observación libre. Los chips salen del
 * catálogo global `cucinaerp.ingredientes` (GET /api/ingredientes).
 *
 * La mitad-y-mitad NO se maneja acá: sigue en `MitadMitadPicker`, que se
 * dispara desde el botón "Mitad y mitad" del pedido. Este modal aparece
 * cuando el mozo elige UN sabor entero desde la lista de pizzas.
 */
export default function PersonalizarPizzaModal({ open, productoNombre, onClose, onConfirm }: Props) {
  const [cantidad, setCantidad] = useState(1);
  const [observacion, setObservacion] = useState("");
  const [agregar, setAgregar] = useState<Set<string>>(new Set());
  const [quitar, setQuitar] = useState<Set<string>>(new Set());
  const [catalogo, setCatalogo] = useState<Ingrediente[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset al abrir
  useEffect(() => {
    if (!open) return;
    setCantidad(1);
    setObservacion("");
    setAgregar(new Set());
    setQuitar(new Set());
    setError(null);
  }, [open]);

  // Cargar catálogo (una sola vez por apertura)
  useEffect(() => {
    if (!open) return;
    let cancelado = false;
    setCargando(true);
    getIngredientesCatalogo().then((r) => {
      if (cancelado) return;
      if (r.success) setCatalogo(r.ingredientes);
      else setError(r.error);
      setCargando(false);
    });
    return () => { cancelado = true; };
  }, [open]);

  const ordenados = useMemo(
    () => [...catalogo].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
    [catalogo]
  );

  function toggle(setState: React.Dispatch<React.SetStateAction<Set<string>>>, otroState: React.Dispatch<React.SetStateAction<Set<string>>>, nombre: string) {
    setState((prev) => {
      const next = new Set(prev);
      if (next.has(nombre)) next.delete(nombre);
      else {
        next.add(nombre);
        // No podés agregar y quitar el mismo ingrediente en el mismo ítem: se
        // pisan y no significa nada útil para cocina.
        otroState((otro) => {
          if (!otro.has(nombre)) return otro;
          const o = new Set(otro); o.delete(nombre); return o;
        });
      }
      return next;
    });
  }

  function confirmar() {
    if (cantidad <= 0) { setError("Cantidad inválida."); return; }
    onConfirm({
      cantidad,
      observacion: observacion.trim() ? observacion.trim() : null,
      ingredientes_agregar: [...agregar],
      ingredientes_quitar: [...quitar],
    });
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b p-4">
          <Pizza className="h-5 w-5 text-red-600" />
          <h2 className="flex-1 text-lg font-semibold">Personalizar pizza</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="p-4 space-y-4">
          <div>
            <div className="text-sm text-gray-500">Producto</div>
            <div className="text-base font-medium">{productoNombre}</div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">Cantidad</label>
            <input
              type="number"
              min={1}
              value={cantidad}
              onChange={(e) => setCantidad(Math.max(1, Number(e.target.value) || 1))}
              className="w-20 rounded border px-2 py-1 text-right"
            />
          </div>

          {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-green-700">Agregar ingredientes</div>
              {agregar.size > 0 && (
                <button onClick={() => setAgregar(new Set())} className="text-xs text-gray-500 hover:underline">
                  Limpiar
                </button>
              )}
            </div>
            {cargando ? (
              <div className="text-sm text-gray-500">Cargando catálogo…</div>
            ) : ordenados.length === 0 ? (
              <div className="text-sm text-gray-500">Catálogo vacío.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {ordenados.map((ing) => {
                  const activo = agregar.has(ing.nombre);
                  return (
                    <button
                      key={ing.id}
                      onClick={() => toggle(setAgregar, setQuitar, ing.nombre)}
                      className={`rounded-full border px-3 py-1 text-sm ${
                        activo
                          ? "border-green-600 bg-green-50 text-green-800"
                          : "border-gray-300 bg-white text-gray-700 hover:border-green-400"
                      }`}
                    >
                      + {ing.nombre}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-red-700">Quitar ingredientes</div>
              {quitar.size > 0 && (
                <button onClick={() => setQuitar(new Set())} className="text-xs text-gray-500 hover:underline">
                  Limpiar
                </button>
              )}
            </div>
            {ordenados.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {ordenados.map((ing) => {
                  const activo = quitar.has(ing.nombre);
                  return (
                    <button
                      key={ing.id}
                      onClick={() => toggle(setQuitar, setAgregar, ing.nombre)}
                      className={`rounded-full border px-3 py-1 text-sm ${
                        activo
                          ? "border-red-600 bg-red-50 text-red-800"
                          : "border-gray-300 bg-white text-gray-700 hover:border-red-400"
                      }`}
                    >
                      − {ing.nombre}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <label className="mb-1 block text-sm font-semibold text-gray-700">Observación</label>
            <textarea
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              placeholder="Bien horneada, poco queso, etc."
              rows={2}
              className="w-full rounded border p-2 text-sm"
              maxLength={500}
            />
          </section>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t p-4">
          <button
            onClick={onClose}
            className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            onClick={confirmar}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Agregar al pedido
          </button>
        </footer>
      </div>
    </div>
  );
}
