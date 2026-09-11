import type { TipoIvaVenta } from "./types";

/**
 * IVA INCLUIDO — Cucina del Cuore (schema cucinaerp).
 *
 * Todos los precios/costos del ERP de Cucina del Cuore son IVA INCLUIDO: el precio
 * que ve el cajero YA contiene el impuesto. El IVA NO se suma encima; sólo se
 * deduce/desglosa la porción incluida.
 *
 *   total_linea    = precio_unitario × cantidad        (el precio es la verdad)
 *   base_imponible = total_linea / (1 + tasa)          (porción gravada)
 *   iva            = total_linea − base_imponible       (porción de IVA incluida)
 *
 * Ejemplo: producto de 11.000 Gs (10%) → total 11.000, IVA 1.000, base 10.000.
 *
 * Identidad garantizada: base_imponible + iva === total_linea (sin drift de
 * redondeo, porque base se redondea y el iva se calcula como el resto). Esto
 * mantiene consistentes ticket, factura, reportes y la cabecera de venta.
 *
 * Esta es la ÚNICA fuente de cálculo de IVA en ventas: la usan el preview del
 * frontend y el recálculo autoritativo del backend, para que nunca difieran.
 */

const DIVISOR_IVA: Record<TipoIvaVenta, number> = {
  EXENTA: 1,
  "5%": 1.05,
  "10%": 1.1,
};

export interface DesgloseLineaVenta {
  /** Base imponible (gravada) = total_linea − iva. */
  subtotal: number;
  /** Porción de IVA INCLUIDA en el total (no se suma encima). */
  monto_iva: number;
  /** Importe final de la línea = precio_unitario × cantidad (IVA incluido). */
  total_linea: number;
}

/**
 * Desglosa una línea de venta tratando el precio como IVA INCLUIDO.
 * El IVA jamás se suma al total: `total_linea` siempre es `precio × cantidad`.
 */
export function calcularLineaVenta(
  precioUnitario: number,
  cantidad: number,
  tipo: TipoIvaVenta
): DesgloseLineaVenta {
  const precio = Number(precioUnitario) || 0;
  const cant = Number(cantidad) || 0;
  const totalLinea = Math.round(precio * cant);

  if (tipo === "EXENTA" || totalLinea <= 0) {
    return { subtotal: totalLinea, monto_iva: 0, total_linea: totalLinea };
  }

  const base = Math.round(totalLinea / DIVISOR_IVA[tipo]);
  const iva = totalLinea - base;
  return { subtotal: base, monto_iva: iva, total_linea: totalLinea };
}
