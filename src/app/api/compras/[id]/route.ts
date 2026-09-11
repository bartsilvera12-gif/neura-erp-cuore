import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  getCompraById,
  updateCompraCampos,
  deleteCompraConReversa,
} from "@/lib/compras/server/compras-pg";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id);
    const { id } = await ctx.params;

    const compra = await getCompraById(schema, tenant.auth.empresa_id, id);
    if (!compra) return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
    return NextResponse.json(successResponse({ compra }));
  } catch (err) {
    console.error("[/api/compras/[id] GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar la compra."), { status: 500 });
  }
}

/**
 * PATCH /api/compras/[id] — solo campos administrativos.
 *
 * Cantidad, costo unitario y precio de venta quedan fuera: ya movieron el stock
 * y el costo del producto. Editarlos acá dejaría el papel diciendo una cosa y el
 * inventario otra. Para corregirlos: borrar (revierte) y volver a cargar.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id);
    const empresaId = tenant.auth.empresa_id;
    const { id } = await ctx.params;

    const existing = await getCompraById(schema, empresaId, id);
    if (!existing) return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const bloqueados = ["cantidad", "costo_unitario", "precio_venta", "subtotal", "total", "monto_iva"]
      .filter((k) => body[k] !== undefined);
    if (bloqueados.length > 0) {
      return NextResponse.json(
        errorResponse(
          `No se pueden editar ${bloqueados.join(", ")} desde acá: ya impactaron el stock y el costo del producto. Borrá la compra (se revierte el movimiento) y cargala de nuevo.`
        ),
        { status: 400 }
      );
    }

    const patch: Parameters<typeof updateCompraCampos>[3] = {};
    if (body.tipo_pago !== undefined) patch.tipo_pago = body.tipo_pago === "credito" ? "credito" : "contado";
    if (body.plazo_dias !== undefined) {
      patch.plazo_dias =
        body.plazo_dias != null && String(body.plazo_dias).trim() !== ""
          ? parseInt(String(body.plazo_dias), 10) || null
          : null;
    }
    if (body.nro_timbrado !== undefined) {
      const t = String(body.nro_timbrado).trim().toUpperCase();
      if (!t) return NextResponse.json(errorResponse("El N° de timbrado no puede quedar vacío."), { status: 400 });
      patch.nro_timbrado = t;
    }
    if (body.proveedor_id !== undefined) {
      patch.proveedor_id = String(body.proveedor_id);
      if (body.proveedor_nombre !== undefined) patch.proveedor_nombre = String(body.proveedor_nombre);
    }

    try {
      const compra = await updateCompraCampos(schema, empresaId, id, patch);
      if (!compra) return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
      return NextResponse.json(successResponse({ compra }));
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "23503") {
        return NextResponse.json(errorResponse("El proveedor seleccionado no existe."), { status: 400 });
      }
      throw e;
    }
  } catch (err) {
    console.error("[/api/compras/[id] PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo actualizar la compra."), { status: 500 });
  }
}

/**
 * DELETE /api/compras/[id] — borra revirtiendo el impacto en inventario.
 * Ver deleteCompraConReversa para el detalle de qué se revierte y qué no.
 */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id);
    const { id } = await ctx.params;

    const out = await deleteCompraConReversa(schema, tenant.auth.empresa_id, id);
    if (!out.borrada) return NextResponse.json(errorResponse("Compra no encontrada."), { status: 404 });
    return NextResponse.json(successResponse(out));
  } catch (err) {
    console.error("[/api/compras/[id] DELETE]", err instanceof Error ? err.message : err);
    return NextResponse.json(
      errorResponse("No se pudo borrar la compra. El stock no fue modificado."),
      { status: 500 }
    );
  }
}
