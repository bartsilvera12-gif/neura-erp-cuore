"use client";

import ReceptorFactura, {
  validarReceptor,
  type DatosReceptor,
} from "@/components/ventas/ReceptorFactura";

/**
 * Elegir entre ticket y factura al cobrar, con los datos que el SET exige
 * cuando la piden.
 *
 * Vive en un componente propio porque lo usan la caja y el cobro de mesa, y
 * son el mismo momento del negocio: el cliente dice "con factura" y hay que
 * pedirle el RUC. Si cada pantalla tuviera su copia, tarde o temprano una
 * validaría distinto que la otra y habría facturas emitidas con datos que la
 * otra pantalla habría rechazado.
 */
export type TipoComprobante = "ticket" | "factura";

export interface SelectorComprobanteProps {
  valor: TipoComprobante;
  onChange: (v: TipoComprobante) => void;
  receptor: DatosReceptor;
  onReceptorChange: (r: DatosReceptor) => void;
}

const OPCIONES = [
  { v: "ticket" as const, label: "Ticket", nota: "Sin datos del cliente" },
  { v: "factura" as const, label: "Factura", nota: "Necesita RUC" },
];

/** true si se puede cobrar: el ticket siempre, la factura sólo con datos válidos. */
export function comprobanteListo(tipo: TipoComprobante, receptor: DatosReceptor): boolean {
  return tipo === "ticket" || validarReceptor(receptor) === null;
}

export default function SelectorComprobante({
  valor,
  onChange,
  receptor,
  onReceptorChange,
}: SelectorComprobanteProps) {
  const aviso = valor === "factura" ? validarReceptor(receptor) : null;

  return (
    <div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OPCIONES.map((opt) => (
          <label
            key={opt.v}
            className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition ${
              valor === opt.v
                ? "border-amber-500 bg-white font-medium text-amber-700"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            <input
              type="radio"
              name="comprobante"
              value={opt.v}
              checked={valor === opt.v}
              onChange={() => onChange(opt.v)}
              className="h-4 w-4 text-amber-600 focus:ring-amber-500"
            />
            <span>
              {opt.label}
              <span className="ml-1.5 text-xs font-normal text-slate-400">{opt.nota}</span>
            </span>
          </label>
        ))}
      </div>

      {valor === "factura" && (
        <div className="mt-4">
          <ReceptorFactura valor={receptor} onChange={onReceptorChange} />
          {aviso && <p className="mt-2 text-xs text-amber-700">{aviso}</p>}
        </div>
      )}
    </div>
  );
}
