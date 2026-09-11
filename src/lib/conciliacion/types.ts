export type ConciliacionEstado = "pendiente" | "aprobado" | "rechazado";
export type MedioConciliacion = "transferencia" | "tarjeta";

export interface CuentaBancaria {
  id: string;
  nombre: string;
  banco: string | null;
  numero_cuenta: string | null;
  tipo: string | null;
  moneda: string;
  activo: boolean;
}

export interface ConciliacionRow {
  id: string;
  venta_id: string;
  numero_control: string | null;
  mesa_numero: number | null;
  caja_numero: number | null;
  caja_id: string | null;
  medio_pago: MedioConciliacion;
  entidad: string | null;
  cuenta_nombre: string | null;
  cuenta_bancaria_id: string | null;
  referencia: string | null;
  tipo_tarjeta: string | null;
  monto: number;
  estado: ConciliacionEstado;
  fecha_pago: string | null;
  created_at: string;
  observacion: string | null;
  motivo_rechazo: string | null;
}

export interface ConciliacionResumen {
  total_pendiente: number;
  total_aprobado: number;
  total_rechazado: number;
  cantidad: number;
  transferencia_total: number;
  tarjeta_total: number;
}

export interface ConciliacionFiltros {
  desde?: string | null;
  hasta?: string | null;
  estado?: ConciliacionEstado | null;
  medio_pago?: MedioConciliacion | null;
  cuenta_bancaria_id?: string | null;
  caja_id?: string | null;
}
