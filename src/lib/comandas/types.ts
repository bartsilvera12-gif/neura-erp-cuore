/**
 * Tipos de Comandas — Cucina del Cuore (schema cucinaerp).
 *
 * Una comanda es un TICKET interno: el mozo la genera desde Mesas ("Enviar
 * comanda"), y caja/admin la imprime para pasársela a cocina. No es un kanban de
 * producción: estados = generada → impresa (puede reimprimirse) → o cancelada.
 * Imprimir NO crea venta, NO toca caja, stock ni la mesa.
 */

export type EstadoComanda = "generada" | "impresa" | "cancelada";

export const ESTADOS_COMANDA: EstadoComanda[] = ["generada", "impresa", "cancelada"];

/** Sector de producción de una comanda: pizzería (copia completa) o plancha (filtrada). */
export type SectorComanda = "pizzeria" | "plancha";

/**
 * Qué es esta comanda para cocina.
 *
 * - pedido: lo que hay que preparar.
 * - modificacion / cancelacion: un aviso sobre algo que YA salió. No trae
 *   ítems: es un mensaje sobre un pedido anterior, y el detalle viaja adentro.
 */
export type TipoComanda = "pedido" | "modificacion" | "cancelacion";

/** Una línea del aviso: qué había antes y qué hay ahora. */
export interface ComandaAvisoLinea {
  antes: string;
  ahora?: string | null;
  observacion?: string | null;
}

export interface ComandaItem {
  id: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: number;
  observacion: string | null;
  total: number;
  /** estado del ítem en la cuenta (cancelado en Mesas), no de la comanda. */
  cancelado: boolean;
  /** Pizza mitad y mitad: sabores para la sub-línea "½ X + ½ Y". */
  es_mitad_mitad?: boolean;
  mitad_1_nombre?: string | null;
  mitad_2_nombre?: string | null;
}

export interface ComandaCard {
  id: string;
  numero: number;
  estado: EstadoComanda;
  tipo: TipoComanda;
  /** true cuando la mesa ya tenía comandas: esto se suma, no reemplaza. */
  es_agregado: boolean;
  /** Detalle del cambio, sólo en modificación y cancelación. */
  aviso: ComandaAvisoLinea[] | null;
  created_at: string;
  mesa_numero: number | null;
  /** Modalidad de la sesión ('mesa' por defecto). */
  sesion_tipo?: "mesa" | "para_llevar";
  /** Correlativo Para llevar (solo cuando sesion_tipo='para_llevar'). */
  numero_pl?: number | null;
  /** Nombre opcional del cliente (solo cuando sesion_tipo='para_llevar'). */
  nombre_cliente?: string | null;
  /** Nota del pedido, para que cocina sepa si es delivery, retiro, etc. */
  sesion_observacion?: string | null;
  mozo_nombre: string | null;
  /** Suma de ítems vigentes (uso interno; el ticket de cocina NO muestra precio). */
  total: number;
  items: ComandaItem[];
  printed_at: string | null;
  print_count: number;
  /** Sector de producción. null = comanda legacy (anterior al split por sector). */
  sector: SectorComanda | null;
}

/** Filtros del historial de comandas (impresas/canceladas). */
export interface ComandaHistorialFiltros {
  desde?: string | null;   // YYYY-MM-DD (sobre created_at)
  hasta?: string | null;   // YYYY-MM-DD (sobre created_at)
  /** `impresa` | `cancelada`; null/ausente = ambas. */
  estado?: Extract<EstadoComanda, "impresa" | "cancelada"> | null;
  mesa?: number | null;    // número de mesa exacto
  mozo?: string | null;    // coincidencia parcial sobre el nombre del mozo
  numero?: number | null;  // número de comanda exacto
}
