"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, FileText } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import ReceptorFactura, {
  RECEPTOR_VACIO,
  receptorAPayload,
  validarReceptor,
  type DatosReceptor,
} from "@/components/ventas/ReceptorFactura";

/**
 * Emite la factura de una venta ya cobrada, desde el listado.
 *
 * Existe para el caso en que el cliente pide la factura después de haber
 * pagado: en la venta nueva la elección de ticket o factura ya está adentro del
 * formulario.
 */
export default function FacturarVentaModal({
  ventaId,
  numeroControl,
  total,
  onClose,
  onEmitida,
}: {
  ventaId: string;
  numeroControl: string;
  total: number;
  onClose: () => void;
  /** Recibe el id de la factura emitida para llevar al detalle. */
  onEmitida: (facturaId: string) => void;
}) {
  const [receptor, setReceptor] = useState<DatosReceptor>(RECEPTOR_VACIO);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape" && !enviando) onClose();
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose, enviando]);

  async function emitir() {
    const falta = validarReceptor(receptor);
    if (falta) return setError(falta);
    setError(null);
    setEnviando(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/ventas/${ventaId}/facturar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receptorAPayload(receptor)),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        // Si ya estaba facturada, en vez de un error a secas la llevamos.
        const yaId = body?.data?.factura_id;
        if (res.status === 409 && yaId) {
          onEmitida(String(yaId));
          return;
        }
        setError(body?.error ?? "No se pudo emitir la factura.");
        return;
      }
      onEmitida(String(body.data.facturaId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={() => !enviando && onClose()}
    >
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/80 to-[#4FAEB2]/30"
        />
        <div className="px-5 pb-4 pt-5">
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <FileText className="h-5 w-5 text-[#4FAEB2]" aria-hidden />
            Facturar {numeroControl}
          </h3>
          <p className="mt-1 mb-4 text-sm text-slate-500">
            Por Gs. {Math.round(total).toLocaleString("es-PY")}. Se emite la factura del ERP;
            el envío al SET se hace después, desde el detalle.
          </p>

          <ReceptorFactura
            valor={receptor}
            onChange={(d) => { setReceptor(d); setError(null); }}
            disabled={enviando}
            autoFocus
          />

          {error && (
            <p className="mt-3 text-sm text-red-600">
              <AlertTriangle className="inline h-4 w-4 align-[-0.125em]" aria-hidden /> {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
          <button
            type="button"
            disabled={enviando}
            onClick={onClose}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200/60 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={enviando}
            onClick={emitir}
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
          >
            {enviando ? "Emitiendo…" : "Emitir factura"}
          </button>
        </div>
      </div>
    </div>
  );
}
