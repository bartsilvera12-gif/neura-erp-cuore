/**
 * Tipos del módulo Caja por turno — Cucina del Cuore (schema cucinaerp).
 *
 * Una "caja" es un turno: se abre con un monto inicial, se le asocian ventas y
 * movimientos manuales mientras está abierta, y se cierra contando el efectivo.
 * Las ventas pertenecen a la caja por `caja_id`, NO por fecha calendario (el
 * turno cruza la medianoche: 18:00 → 02:00/03:00).
 */

export type EstadoCaja = "abierta" | "cerrada";
export type TipoMovimientoCaja = "ingreso" | "egreso" | "retiro" | "ajuste";
export type MedioPagoCaja = "efectivo" | "tarjeta" | "transferencia" | "qr" | "otro";

export interface Caja {
  id: string;
  numero_caja: number;
  estado: EstadoCaja;
  abierta_por: string | null;
  cerrada_por: string | null;
  fecha_apertura: string;
  fecha_cierre: string | null;
  monto_apertura: number;
  monto_cierre_contado: number | null;
  monto_esperado_efectivo: number | null;
  diferencia: number | null;
  observacion_apertura: string | null;
  observacion_cierre: string | null;
}

export interface CajaMovimiento {
  id: string;
  caja_id: string;
  tipo: TipoMovimientoCaja;
  concepto: string;
  monto: number;
  medio_pago: MedioPagoCaja;
  usuario_id: string | null;
  observacion: string | null;
  created_at: string;
}

/** Totales calculados de una caja (server-side, fuente de verdad del arqueo). */
export interface CajaResumen {
  caja: Caja;
  /** Nombres resueltos (catálogo zentra_erp.usuarios) para mostrar en reportes. */
  abierta_por_nombre: string | null;
  cerrada_por_nombre: string | null;
  /** Cantidad de ventas asociadas a la caja. */
  cantidad_ventas: number;
  /** Σ total de todas las ventas (efectivo + tarjeta + transferencia). */
  total_vendido: number;
  total_efectivo: number;
  total_tarjeta: number;
  total_transferencia: number;
  total_qr: number;
  /** Movimientos manuales en efectivo. */
  ingresos_efectivo: number;
  egresos_efectivo: number;
  retiros_efectivo: number;
  ajustes_efectivo: number;
  /**
   * Efectivo esperado en caja:
   *   monto_apertura + ventas efectivo + ingresos efectivo
   *   − egresos efectivo − retiros efectivo (+ ajustes efectivo).
   * Tarjeta y transferencia NO suman al efectivo esperado.
   */
  efectivo_esperado: number;
  movimientos: CajaMovimiento[];
}

/** Una venta asociada a una caja (para el detalle de cierre). */
export interface VentaDeCaja {
  id: string;
  numero_control: string;
  fecha: string;
  metodo_pago: "efectivo" | "tarjeta" | "transferencia" | "qr" | null;
  total: number;
  cantidad_items: number;
}

/** Detalle completo de una caja: arqueo + movimientos + ventas asociadas. */
/** Desglose de conciliación bancaria asociada a la caja (no afecta efectivo esperado). */
export interface ConciliacionCaja {
  transferencia_pendiente: number;
  transferencia_aprobada: number;
  tarjeta_pendiente: number;
  tarjeta_aprobada: number;
}

export interface CajaDetalle {
  resumen: CajaResumen;
  ventas: VentaDeCaja[];
  conciliacion: ConciliacionCaja;
}

/**
 * Estado de cuenta de la lomitería: agregado sobre cajas CERRADAS en un rango
 * (por fecha_cierre). neto_estimado = total_vendido − egresos − retiros.
 */
export interface EstadoCuentaLomiteria {
  desde: string | null;
  hasta: string | null;
  cajas_cerradas: number;
  total_vendido: number;
  total_efectivo: number;
  total_transferencia: number;
  total_tarjeta: number;
  total_qr: number;
  total_egresos: number;
  total_retiros: number;
  diferencias_acumuladas: number;
  promedio_vendido: number;
  neto_estimado: number;
}
