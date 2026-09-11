import { calcularLineaVenta } from "@/lib/ventas/iva";
import type { TipoIvaVenta } from "@/lib/ventas/types";

/**
 * Reparte un descuento entre las líneas de la venta.
 *
 * El descuento NO se guarda como un total aparte que se resta al final. Se
 * reparte y baja el precio de cada línea, y el resto del sistema no se entera:
 * el IVA se sigue calculando línea por línea, la factura electrónica copia esas
 * líneas y sus totales cierran solos, y el KUDE muestra lo mismo que el ticket.
 *
 * Un descuento guardado sólo en la cabecera haría que la suma de los ítems de
 * la factura no coincidiera con su total, y el SET rechaza el documento por eso.
 *
 * El reparto es proporcional al peso de cada línea. Como todo se redondea a
 * guaraníes enteros, la suma de las partes casi nunca da exacto: la diferencia
 * que sobra se le carga a la línea más grande, que es donde menos se nota y
 * donde no puede dejar un precio negativo.
 */
export interface LineaDescontable {
  precio_venta: number;
  cantidad: number;
  tipo_iva: TipoIvaVenta;
}

export interface LineaConDescuento<T> {
  linea: T;
  /** Precio unitario ya descontado, listo para guardar. */
  precioFinal: number;
}

/** Total de una línea con el mismo redondeo que usa el resto del sistema. */
function totalDeLinea(l: LineaDescontable): number {
  return calcularLineaVenta(l.precio_venta, l.cantidad, l.tipo_iva).total_linea;
}

export function totalSinDescuento(lineas: LineaDescontable[]): number {
  return lineas.reduce((s, l) => s + totalDeLinea(l), 0);
}

/**
 * Devuelve cada línea con su precio unitario ya descontado.
 *
 * `descuento` es el monto total en guaraníes a descontar. Si es 0, o mayor o
 * igual al total, se devuelve sin tocar: regalar la venta entera no es un
 * descuento y hay que decidirlo en otro lado, no acá.
 */
export function repartirDescuento<T extends LineaDescontable>(
  lineas: T[],
  descuento: number
): LineaConDescuento<T>[] {
  const total = totalSinDescuento(lineas);
  const d = Math.round(Number(descuento) || 0);

  if (d <= 0 || total <= 0 || d >= total) {
    return lineas.map((linea) => ({ linea, precioFinal: linea.precio_venta }));
  }

  // Cuánto queda por cobrar de cada línea, proporcional a lo que pesaba.
  const objetivo = total - d;
  const nuevos = lineas.map((l) => {
    const t = totalDeLinea(l);
    return Math.round((t * objetivo) / total);
  });

  // El redondeo deja sobrante o faltante: se ajusta en la línea más grande, que
  // es la que puede absorberlo sin quedar en cero ni en negativo.
  const suma = nuevos.reduce((s, n) => s + n, 0);
  const resto = objetivo - suma;
  if (resto !== 0) {
    let iMayor = 0;
    for (let i = 1; i < nuevos.length; i++) {
      if (nuevos[i]! > nuevos[iMayor]!) iMayor = i;
    }
    nuevos[iMayor] = Math.max(0, nuevos[iMayor]! + resto);
  }

  return lineas.map((linea, i) => {
    const cant = Number(linea.cantidad) || 1;
    return {
      linea,
      // El precio unitario es el vehículo: total_linea = precio × cantidad, así
      // que se divide y el sistema recalcula el resto como con cualquier venta.
      precioFinal: cant > 0 ? nuevos[i]! / cant : 0,
    };
  });
}

/**
 * Descuento en guaraníes a partir de un porcentaje sobre el total.
 *
 * Se redondea acá y no en la pantalla para que el monto que se guarda sea
 * exactamente el que se aplicó, sin diferencias de un guaraní entre lo que vio
 * el cajero y lo que quedó registrado.
 */
export function descuentoDesdePorcentaje(total: number, porcentaje: number): number {
  const p = Math.max(0, Math.min(100, Number(porcentaje) || 0));
  return Math.round(((Number(total) || 0) * p) / 100);
}
