"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

/**
 * Confirmación integrada, en reemplazo de `window.confirm`.
 *
 * El diálogo nativo lo dibuja el navegador: no respeta la paleta del ERP,
 * muestra el dominio ("lacaribena.neura.com.py dice") y en algunos navegadores
 * ofrece silenciar futuros avisos — justo en la acción que no querés que se
 * saltee.
 *
 * Se expone como función suelta y no como hook para que los call sites cambien
 * lo mínimo: `if (!confirm(x)) return` pasa a `if (!(await confirmar(x))) return`.
 */

type Pedido = {
  mensaje: string;
  confirmLabel: string;
  cancelLabel: string;
  destructivo: boolean;
  resolver: (ok: boolean) => void;
};

let emitir: ((p: Pedido | null) => void) | null = null;

export type ConfirmarOpts = {
  confirmLabel?: string;
  cancelLabel?: string;
  /** Pinta el botón principal en rojo. Por defecto true: casi todo uso es un borrado. */
  destructivo?: boolean;
};

export function confirmar(mensaje: string, opts: ConfirmarOpts = {}): Promise<boolean> {
  // Sin provider montado (SSR, tests) no bloqueamos la acción.
  if (!emitir) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    emitir?.({
      mensaje,
      confirmLabel: opts.confirmLabel ?? "Confirmar",
      cancelLabel: opts.cancelLabel ?? "Cancelar",
      destructivo: opts.destructivo ?? true,
      resolver: resolve,
    });
  });
}

export default function ConfirmDialogHost() {
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [montado, setMontado] = useState(false);

  useEffect(() => setMontado(true), []);

  useEffect(() => {
    emitir = setPedido;
    return () => {
      emitir = null;
    };
  }, []);

  const cerrar = useCallback(
    (ok: boolean) => {
      setPedido((actual) => {
        actual?.resolver(ok);
        return null;
      });
    },
    []
  );

  useEffect(() => {
    if (!pedido) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cerrar(false);
      if (e.key === "Enter") cerrar(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pedido, cerrar]);

  if (!montado || !pedido) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={() => cerrar(false)}
      role="alertdialog"
      aria-modal="true"
    >
      <div
        className="my-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3 px-5 pb-4 pt-5">
          <span
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              pedido.destructivo ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600"
            }`}
            aria-hidden
          >
            <AlertTriangle className="h-5 w-5" />
          </span>
          <p className="pt-1 text-sm leading-relaxed text-slate-700">{pedido.mensaje}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={() => cerrar(false)}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
          >
            {pedido.cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => cerrar(true)}
            className={`rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-colors ${
              pedido.destructivo ? "bg-red-600 hover:bg-red-700" : "bg-slate-900 hover:bg-slate-700"
            }`}
          >
            {pedido.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
