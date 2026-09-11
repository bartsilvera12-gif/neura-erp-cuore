export type TipoIvaVenta = "EXENTA" | "5%" | "10%";
export type TipoVenta   = "CONTADO" | "CREDITO";
export type MonedaVenta = "GS" | "USD";
/** Formas de cobro. QR no entra al cajón: para el arqueo va como no efectivo. */
export type MetodoPago  = "efectivo" | "tarjeta" | "transferencia" | "qr";

/** Un ítem dentro de una venta (una línea de producto). */
export interface LineaVenta {
  producto_id:           string;
  producto_nombre:       string;
  sku:                   string;
  cantidad:              number;
  precio_venta_original: number;  // en la moneda elegida (IVA incluido)
  precio_venta:          number;  // siempre en GS (IVA incluido)
  tipo_iva:              TipoIvaVenta;
  subtotal:              number;  // base imponible = total_linea − monto_iva
  monto_iva:             number;  // IVA INCLUIDO en el precio (no se suma encima)
  total_linea:           number;  // precio_venta × cantidad (IVA incluido) = subtotal + monto_iva
  /** Sector de producción del producto (para decidir copias de impresión en el front). */
  sector_produccion?:    "ninguno" | "pizzeria" | "plancha";
  /** Pizza mitad y mitad (metadata; precio_venta ya es el max de ambos sabores). */
  es_mitad_mitad?:       boolean;
  mitad_1_producto_id?:  string | null;
  mitad_2_producto_id?:  string | null;
  mitad_1_nombre?:       string | null;
  mitad_2_nombre?:       string | null;
  item_display_name?:    string | null;
}

/** Una forma de pago dentro del cobro de una venta. */
export interface PagoVenta {
  metodo_pago: MetodoPago;
  monto: number;
  referencia?: string | null;
}

/** Cabecera de venta: condiciones comerciales + totales consolidados. */
export interface Venta {
  /** UUID en base de datos (antes del bloque DB-first era numérico local). */
  id:             string;
  numero_control: string;   // VTA-000001, VTA-000002, …

  items: LineaVenta[];       // 1 o más productos

  moneda:      MonedaVenta;
  tipo_cambio: number;       // 1 si moneda === "GS"

  subtotal:  number;         // Σ subtotal de ítems
  monto_iva: number;         // Σ monto_iva de ítems
  total:     number;         // Σ total_linea de ítems

  tipo_venta: TipoVenta;
  plazo_dias?: number;       // solo si tipo_venta === "CREDITO"

  metodo_pago?: MetodoPago;  // Cucina del Cuore: efectivo/tarjeta/transferencia

  /**
   * Cómo se cobró: una línea por forma de pago. Con una sola forma es una
   * línea; con cobro repartido, varias. `metodo_pago` queda con la de mayor
   * monto para el listado y los filtros.
   */
  pagos?: PagoVenta[];

  fecha: string;             // ISO string, generado automáticamente

  /** Factura del ERP, si el cliente pidió factura. null = se cobró sin factura. */
  factura_id?: string | null;

  /** completada | anulada. Una anulada no cuenta en caja ni en los reportes. */
  estado?: string;
}
