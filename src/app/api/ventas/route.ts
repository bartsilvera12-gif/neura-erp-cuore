import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import type { Venta, LineaVenta, TipoIvaVenta } from "@/lib/ventas/types";

interface VentaRow {
  id: string;
  empresa_id: string;
  numero_control: string;
  factura_id?: string | null;
  estado?: string | null;
  moneda: string;
  tipo_cambio: number | string;
  subtotal: number | string;
  monto_iva: number | string;
  total: number | string;
  tipo_venta: string;
  plazo_dias: number | null;
  fecha: string;
}

interface VentaItemRow {
  venta_id: string;
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number | string;
  precio_venta_original: number | string;
  precio_venta: number | string;
  tipo_iva: string;
  subtotal: number | string;
  monto_iva: number | string;
  total_linea: number | string;
}

function num(v: number | string): number {
  return typeof v === "number" ? v : Number(v);
}

function mapItems(rows: VentaItemRow[]): LineaVenta[] {
  return rows.map((r) => ({
    producto_id: r.producto_id,
    producto_nombre: r.producto_nombre,
    sku: r.sku,
    cantidad: num(r.cantidad),
    precio_venta_original: num(r.precio_venta_original),
    precio_venta: num(r.precio_venta),
    tipo_iva: r.tipo_iva as TipoIvaVenta,
    subtotal: num(r.subtotal),
    monto_iva: num(r.monto_iva),
    total_linea: num(r.total_linea),
  }));
}

/** GET /api/ventas — listado vía PostgREST (compatible Hostinger sin pool). */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    // PostgREST corta cada respuesta en 1000 filas (y antes había un tope manual de
    // 500 ventas). Para traer TODO sin límite, paginamos con `.range()` en bloques de
    // 1000 hasta agotar. URL corta (solo filtro por empresa); NO se listan ids en la
    // URL (eso la haría exceder el límite de longitud del proxy y romper el listado).
    const PAGE = 1000;

    const ventasRows: VentaRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const ventasQ = await ctx.supabase
        .from("ventas")
        .select(
          "id, empresa_id, numero_control, moneda, tipo_cambio, subtotal, monto_iva, total, tipo_venta, plazo_dias, metodo_pago, fecha, factura_id, estado"
        )
        .eq("empresa_id", empresaId)
        .order("fecha", { ascending: false })
        .range(from, from + PAGE - 1);
      if (ventasQ.error) throw new Error(ventasQ.error.message);
      const page = (ventasQ.data ?? []) as VentaRow[];
      for (const row of page) ventasRows.push(row);
      if (page.length < PAGE) break;
    }

    const itemsRows: VentaItemRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const itemsQ = await ctx.supabase
        .from("ventas_items")
        .select(
          "venta_id, producto_id, producto_nombre, sku, cantidad, precio_venta_original, precio_venta, tipo_iva, subtotal, monto_iva, total_linea"
        )
        .eq("empresa_id", empresaId)
        .order("venta_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (itemsQ.error) throw new Error(itemsQ.error.message);
      const page = (itemsQ.data ?? []) as VentaItemRow[];
      for (const row of page) itemsRows.push(row);
      if (page.length < PAGE) break;
    }

    const byVenta = new Map<string, VentaItemRow[]>();
    for (const row of itemsRows) {
      const list = byVenta.get(row.venta_id) ?? [];
      list.push(row);
      byVenta.set(row.venta_id, list);
    }

    const ventas: Venta[] = ventasRows.map((r) => {
      const lineRows = byVenta.get(r.id) ?? [];
      return {
        id: r.id,
        numero_control: r.numero_control,
        factura_id: r.factura_id ?? null,
        estado: r.estado ?? "completada",
        items: mapItems(lineRows),
        moneda: r.moneda === "USD" ? "USD" : "GS",
        tipo_cambio: num(r.tipo_cambio),
        subtotal: num(r.subtotal),
        monto_iva: num(r.monto_iva),
        total: num(r.total),
        tipo_venta: r.tipo_venta === "CREDITO" ? "CREDITO" : "CONTADO",
        plazo_dias: r.plazo_dias ?? undefined,
        metodo_pago: (r as unknown as { metodo_pago?: string }).metodo_pago === "tarjeta"
          ? "tarjeta"
          : (r as unknown as { metodo_pago?: string }).metodo_pago === "transferencia"
          ? "transferencia"
          : (r as unknown as { metodo_pago?: string }).metodo_pago === "efectivo"
          ? "efectivo"
          : undefined,
        fecha: r.fecha,
      };
    });

    return NextResponse.json(successResponse({ ventas }));
  } catch (err) {
    console.error("[/api/ventas GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las ventas."), { status: 500 });
  }
}
