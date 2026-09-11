"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Search, UserPlus, X } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/**
 * Datos del receptor de una factura, tal como se piden en el mostrador.
 *
 * Acá sólo se factura con RUC, que es como trabaja el local: la factura va
 * siempre a nombre de un contribuyente. Para una venta sin RUC está el ticket,
 * que es la otra opción del comprobante.
 *
 * Mandar un RUC de alguien que no está inscripto hace que la SET rechace el
 * lote entero, así que el formulario lo advierte.
 *
 * Primero busca entre los clientes ya cargados — al que factura seguido no hay
 * que tipearle el RUC cada vez — y si no está, lo carga en el momento y queda
 * guardado para la próxima.
 *
 * Se usa igual desde la venta nueva y desde el listado, para que el cajero vea
 * lo mismo en los dos lados.
 */

export interface DatosReceptor {
  ruc: string;
  razonSocial: string;
  /** A dónde se le manda la factura. Opcional: no todos lo dan. */
  email: string;
  /** Cliente ya cargado que se eligió del buscador. */
  clienteId: string | null;
  /** Guardar en Clientes al facturar. Sólo aplica si no vino de la búsqueda. */
  guardar: boolean;
}

export const RECEPTOR_VACIO: DatosReceptor = {
  ruc: "",
  razonSocial: "",
  email: "",
  clienteId: null,
  guardar: true,
};

/** Qué falta para poder emitir. null = está listo. */
export function validarReceptor(d: DatosReceptor): string | null {
  if (!d.ruc.trim()) return "Ingresá el RUC del cliente.";
  if (!d.razonSocial.trim()) return "Ingresá la razón social del cliente.";
  // El correo es opcional, pero uno mal escrito es peor que ninguno: la factura
  // se daría por enviada a una dirección que no existe.
  const mail = d.email.trim();
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) {
    return "El correo no parece válido. Corregilo o dejalo vacío.";
  }
  return null;
}

/** Cuerpo que espera /api/ventas/[id]/facturar. */
export function receptorAPayload(d: DatosReceptor): Record<string, string | boolean> {
  const base: Record<string, string | boolean> = {
    razon_social: d.razonSocial.trim(),
    ruc: d.ruc.trim(),
  };
  if (d.email.trim()) base.email = d.email.trim();
  // Un cliente ya cargado se referencia; uno nuevo se guarda si lo pidieron.
  if (d.clienteId) base.cliente_id = d.clienteId;
  else base.guardar_cliente = d.guardar;
  return base;
}

type ClienteHit = {
  id: string;
  razon_social: string;
  ruc: string | null;
  documento: string | null;
  email: string | null;
  es_contribuyente: boolean;
};

const inputCls =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";
const labelCls =
  "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

export default function ReceptorFactura({
  valor,
  onChange,
  disabled,
  autoFocus,
}: {
  valor: DatosReceptor;
  onChange: (d: DatosReceptor) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const set = (parcial: Partial<DatosReceptor>) => onChange({ ...valor, ...parcial });

  const [busqueda, setBusqueda] = useState("");
  const [hits, setHits] = useState<ClienteHit[]>([]);
  const [buscando, setBuscando] = useState(false);
  /**
   * Por qué falló la búsqueda, si falló. Sin esto un error de red o de permisos
   * se ve igual que "no hay clientes con ese nombre", y el cajero se queda
   * escribiendo contra una pantalla muda.
   */
  const [errorBusqueda, setErrorBusqueda] = useState<string | null>(null);
  const cajaRef = useRef<HTMLDivElement>(null);

  // Se espera a que deje de tipear: en el mostrador se escribe rápido y una
  // consulta por tecla no le sirve a nadie.
  useEffect(() => {
    const q = busqueda.trim();
    if (q.length < 2) { setHits([]); return; }
    let cancelado = false;
    setBuscando(true);
    setErrorBusqueda(null);
    const t = setTimeout(async () => {
      try {
        const res = await fetchWithSupabaseSession(
          `/api/clientes/buscar?q=${encodeURIComponent(q)}`,
          { cache: "no-store" }
        );
        const body = await res.json().catch(() => null);
        if (cancelado) return;
        if (!res.ok || body?.success === false) {
          setHits([]);
          setErrorBusqueda(
            body?.error ?? `No se pudo buscar (error ${res.status}). Cargá los datos a mano.`
          );
          return;
        }
        setHits(Array.isArray(body?.data?.clientes) ? body.data.clientes : []);
      } catch (e) {
        if (!cancelado) {
          setHits([]);
          setErrorBusqueda(
            `No se pudo buscar: ${e instanceof Error ? e.message : "error de red"}. Cargá los datos a mano.`
          );
        }
      } finally {
        if (!cancelado) setBuscando(false);
      }
    }, 250);
    return () => { cancelado = true; clearTimeout(t); };
  }, [busqueda]);

  useEffect(() => {
    function fuera(e: MouseEvent) {
      if (!cajaRef.current?.contains(e.target as Node)) setHits([]);
    }
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, []);

  function elegir(c: ClienteHit) {
    onChange({
      ruc: c.ruc ?? "",
      razonSocial: c.razon_social,
      email: c.email ?? "",
      clienteId: c.id,
      guardar: false,
    });
    setBusqueda("");
    setHits([]);
  }

  function soltarCliente() {
    set({ clienteId: null, guardar: true });
  }

  return (
    <div className="space-y-3">
      {/* Buscador de clientes ya cargados */}
      {valor.clienteId ? (
        <div className="flex items-center gap-2 rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/10 px-3 py-2.5 text-sm">
          <Check className="h-4 w-4 shrink-0 text-[#3F8E91]" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium text-[#2F6E71]">
            Cliente cargado: {valor.razonSocial}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={soltarCliente}
            className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-white hover:text-slate-700 disabled:opacity-50"
            aria-label="Quitar el cliente elegido"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <div ref={cajaRef} className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            value={busqueda}
            disabled={disabled}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar cliente ya cargado por nombre o RUC…"
            className={`${inputCls} pl-9`}
          />
          {hits.length > 0 && (
            <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
              {hits.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); elegir(c); }}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-[#4FAEB2]/10"
                  >
                    <span className="font-medium text-slate-800">{c.razon_social}</span>
                    <span className="text-xs text-slate-500">
                      {c.ruc ? `RUC ${c.ruc}` : "Sin RUC — no se le puede facturar"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {buscando && <p className="mt-1.5 text-xs text-slate-400">Buscando…</p>}
          {errorBusqueda && (
            <p className="mt-1.5 text-xs font-medium text-amber-700">{errorBusqueda}</p>
          )}
          {busqueda.trim().length >= 2 && !buscando && !errorBusqueda && hits.length === 0 && (
            <p className="mt-1.5 text-xs text-slate-400">
              No hay ningún cliente con eso. Cargá los datos abajo y se guarda solo.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>RUC</label>
          <input
            autoFocus={autoFocus}
            disabled={disabled || !!valor.clienteId}
            value={valor.ruc}
            onChange={(e) => set({ ruc: e.target.value })}
            placeholder="Ej: 80012345-6"
            maxLength={20}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Razón social</label>
          <input
            disabled={disabled || !!valor.clienteId}
            value={valor.razonSocial}
            onChange={(e) => set({ razonSocial: e.target.value })}
            placeholder="Nombre que figura en el RUC"
            maxLength={250}
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <label className={labelCls}>
          Correo <span className="font-normal text-slate-400">(opcional)</span>
        </label>
        <input
          type="email"
          disabled={disabled}
          value={valor.email}
          onChange={(e) => set({ email: e.target.value })}
          placeholder="Para mandarle la factura"
          maxLength={200}
          inputMode="email"
          autoComplete="off"
          className={inputCls}
        />
      </div>

      {/* Guardar en Clientes: sólo tiene sentido si no vino de la búsqueda. */}
      {!valor.clienteId && (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            disabled={disabled}
            checked={valor.guardar}
            onChange={(e) => set({ guardar: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-[#4FAEB2] focus:ring-[#4FAEB2]"
          />
          <UserPlus className="h-4 w-4 text-slate-400" aria-hidden />
          Guardar en Clientes para la próxima vez
        </label>
      )}

      {!valor.clienteId && (
        <p className="text-xs text-slate-400">
          El RUC tiene que estar inscripto en Marangatú: el SET rechaza el documento si no
          figura en el padrón. Si el cliente no tiene RUC, cobrale con ticket.
        </p>
      )}
    </div>
  );
}
