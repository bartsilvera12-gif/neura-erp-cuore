import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { actualizarItemPg } from "@/lib/mesas/server/mesas-pg";
import { parseMitadFromBody } from "@/lib/mesas/mitad-parse";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * PATCH /api/mesas/items/[itemId]
 *
 * Edita una línea del pedido: cantidad, nota de cocina, producto (cuando se
 * cargó el sabor equivocado) o la cancela.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { itemId } = await ctx.params;

    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const item = await actualizarItemPg({
      schema, empresaId: auth.empresa_id, itemId,
      cantidad: o.cantidad != null ? Number(o.cantidad) : undefined,
      observacion: o.observacion !== undefined ? (o.observacion == null ? null : String(o.observacion).slice(0, 2000)) : undefined,
      cancelar: o.cancelar === true,
      productoId: typeof o.producto_id === "string" && o.producto_id.trim() !== "" ? o.producto_id.trim() : undefined,
      ...(() => {
        const m = parseMitadFromBody(o);
        return { precioUnitario: m.precioUnitario, displayName: m.displayName, mitad: m.mitad };
      })(),
      usuarioId: auth.usuarioCatalogId ?? null,
      usuarioNombre: auth.user?.email ?? null,
    });
    return NextResponse.json(successResponse({ item }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo actualizar el ítem.";
    const status = msg.includes("no encontrado") ? 404 : msg.includes("mayor a 0") || msg.includes("Nada para") ? 400 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
