import type { Compra } from "./types";

interface CompraApiRow {
  id: string; numero_control: string; proveedor_id: string; proveedor_nombre: string;
  producto_id: string; producto_nombre: string; cantidad: string | number; moneda: string;
  tipo_cambio: string | number; costo_unitario_original: string | number;
  costo_unitario: string | number; iva_tipo: string;
  subtotal: string | number; monto_iva: string | number; total: string | number;
  precio_venta: string | number; margen_venta: string | number | null;
  tipo_pago: string; plazo_dias: number | null; nro_timbrado: string; estado: string;
  fecha: string;
}

function mapRow(r: CompraApiRow): Compra {
  return {
    id: r.id,
    numero_control: r.numero_control,
    proveedor_id: r.proveedor_id,
    proveedor_nombre: r.proveedor_nombre,
    producto_id: r.producto_id,
    producto_nombre: r.producto_nombre,
    cantidad: Number(r.cantidad),
    moneda: (r.moneda === "USD" ? "USD" : "PYG") as Compra["moneda"],
    tipo_cambio: Number(r.tipo_cambio),
    costo_unitario_original: Number(r.costo_unitario_original),
    costo_unitario: Number(r.costo_unitario),
    iva_tipo: r.iva_tipo as Compra["iva_tipo"],
    subtotal: Number(r.subtotal),
    monto_iva: Number(r.monto_iva),
    total: Number(r.total),
    precio_venta: Number(r.precio_venta),
    margen_venta: r.margen_venta != null ? Number(r.margen_venta) : 0,
    tipo_pago: r.tipo_pago as Compra["tipo_pago"],
    plazo_dias: r.plazo_dias ?? undefined,
    nro_timbrado: r.nro_timbrado,
    fecha: r.fecha,
  };
}

export async function getCompras(): Promise<Compra[]> {
  try {
    const r = await fetch("/api/compras", { credentials: "include", cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) {
      console.error("[compras] getCompras:", (j as { error?: string })?.error ?? r.status);
      return [];
    }
    const list = ((j.data as { compras?: CompraApiRow[] }).compras ?? []) as CompraApiRow[];
    return list.map(mapRow);
  } catch (e) {
    console.error("[compras] getCompras:", e);
    return [];
  }
}

export interface SaveCompraResult {
  success: true;
  compra: Compra;
  warning?: string | null;
}
export interface SaveCompraError {
  success: false;
  error: string;
}

export async function saveCompra(
  datos: Omit<Compra, "id" | "numero_control" | "fecha">
): Promise<SaveCompraResult | SaveCompraError> {
  try {
    const r = await fetch("/api/compras", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(datos),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) {
      const err = (j as { error?: string })?.error ?? `Error ${r.status} al guardar la compra.`;
      console.error("[compras] saveCompra:", err);
      return { success: false, error: err };
    }
    const data = j.data as { compra?: CompraApiRow; warning?: string | null };
    if (!data.compra) {
      return { success: false, error: "Respuesta inválida del servidor." };
    }
    return { success: true, compra: mapRow(data.compra), warning: data.warning ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error de red";
    console.error("[compras] saveCompra:", e);
    return { success: false, error: msg };
  }
}

// ── Compra de varios productos ────────────────────────────────────────────

/** Datos que son iguales para toda la factura del proveedor. */
export interface CompraCabecera {
  proveedor_id: string;
  proveedor_nombre: string;
  moneda: Compra["moneda"];
  tipo_cambio: number;
  tipo_pago: Compra["tipo_pago"];
  plazo_dias?: number;
  nro_timbrado: string;
}

/** Una línea de la factura. El IVA es por línea. */
export interface CompraLinea {
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: Compra["iva_tipo"];
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number;
}

export interface SaveCompraMultiResult {
  success: true;
  numero_control: string;
  compras: Compra[];
  warning?: string | null;
}

export async function saveCompraMultilinea(
  cabecera: CompraCabecera,
  items: CompraLinea[]
): Promise<SaveCompraMultiResult | SaveCompraError> {
  try {
    const r = await fetch("/api/compras", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...cabecera, items }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.success) {
      const err = (j as { error?: string })?.error ?? `Error ${r.status} al guardar la compra.`;
      console.error("[compras] saveCompraMultilinea:", err);
      return { success: false, error: err };
    }
    const data = j.data as {
      numero_control?: string;
      compras?: CompraApiRow[];
      warning?: string | null;
    };
    if (!data.compras?.length) {
      return { success: false, error: "Respuesta inválida del servidor." };
    }
    return {
      success: true,
      numero_control: data.numero_control ?? data.compras[0].numero_control,
      compras: data.compras.map(mapRow),
      warning: data.warning ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error de red";
    console.error("[compras] saveCompraMultilinea:", e);
    return { success: false, error: msg };
  }
}
