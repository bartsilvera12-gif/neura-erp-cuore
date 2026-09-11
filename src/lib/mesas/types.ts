/**
 * Tipos del módulo Mesas — Cucina del Cuore (schema cucinaerp).
 *
 * El mozo abre una cuenta por mesa (mesa_sesiones) y le agrega ítems
 * (mesa_sesion_items). NO se crea venta ni se toca stock/caja hasta que CAJA
 * factura la mesa, reutilizando la lógica de ventas/caja. La conversión a venta
 * es idempotente (mesa_sesiones.venta_id).
 */

export type EstadoMesa = "libre" | "ocupada" | "por_cobrar" | "cerrada" | "inactiva";
export type EstadoSesion = "abierta" | "por_cobrar" | "facturada" | "cancelada";
/** Modalidad del pedido. 'mesa' consume mesa_id; 'para_llevar' no ocupa mesa. */
export type TipoSesion = "mesa" | "para_llevar";
/**
 * Estado de un ítem de cuenta:
 *  - pendiente: agregado por el mozo, aún no enviado a cocina (editable/cancelable).
 *  - enviado: incluido en una comanda (cocina). Sigue contando en la cuenta.
 *  - cancelado: anulado (no cuenta).
 */
export type EstadoItemMesa = "pendiente" | "enviado" | "cancelado";

export interface Mesa {
  id: string;
  numero: number;
  nombre: string | null;
  estado: EstadoMesa;
  activo: boolean;
}

export interface MesaSesion {
  id: string;
  /** null cuando tipo === 'para_llevar'. */
  mesa_id: string | null;
  tipo: TipoSesion;
  /** Solo para tipo='para_llevar'. Correlativo por empresa, arranca en 1, no resetea. */
  numero_pl: number | null;
  /** Nombre opcional del cliente (identifica al mostrador). */
  nombre_cliente: string | null;
  estado: EstadoSesion;
  mozo_id: string | null;
  abierta_at: string;
  enviada_caja_at: string | null;
  cerrada_at: string | null;
  venta_id: string | null;
  observacion: string | null;
}

/** Resumen de una sesión PARA LLEVAR para la lista/sidebar. */
export interface ParaLlevarConResumen {
  sesion: MesaSesion;
  total: number;
  items_count: number;
  mozo_nombre: string | null;
}

export interface MesaSesionItem {
  id: string;
  sesion_id: string;
  producto_id: string;
  producto_nombre: string;
  sku: string | null;
  cantidad: number;
  precio_unitario: number;
  total: number;
  observacion: string | null;
  estado: EstadoItemMesa;
  comanda_id: string | null;
  enviado_at: string | null;
  /** Pizza mitad y mitad (metadata; precio_unitario ya es el max de ambos sabores). */
  es_mitad_mitad?: boolean;
  mitad_1_nombre?: string | null;
  mitad_2_nombre?: string | null;
  item_display_name?: string | null;
}

/** Una comanda enviada a cocina (un envío de ítems de una sesión). */
export interface Comanda {
  id: string;
  sesion_id: string;
  numero: number;
  created_at: string;
  items_count: number;
}

/** Una comanda de producción creada al enviar (pizzería o plancha). */
export interface ComandaEnvioInfo {
  id: string;
  numero: number;
  sector: "pizzeria" | "plancha";
  items_count: number;
}

/** Resultado de "Enviar comanda": comandas por sector creadas en un batch. */
export interface ComandaEnvioResult {
  comandas: ComandaEnvioInfo[];
  /** true si había pendientes pero ninguno requiere producción (solo bebidas). */
  sin_produccion: boolean;
  total_pendientes: number;
}

/** Mesa + resumen de su sesión viva (para el grid y la lista por-cobrar). */
export interface MesaConResumen {
  mesa: Mesa;
  sesion: MesaSesion | null;
  total: number;
  items_count: number;
  mozo_nombre: string | null;
}

/** Detalle completo de una mesa: mesa + sesión viva + ítems activos. */
export interface MesaDetalle {
  mesa: Mesa;
  sesion: MesaSesion | null;
  items: MesaSesionItem[];
  total: number;
}
