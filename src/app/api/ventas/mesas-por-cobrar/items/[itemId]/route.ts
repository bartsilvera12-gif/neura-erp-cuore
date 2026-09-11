import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { actualizarItemCajaPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** PATCH /api/ventas/mesas-por-cobrar/items/[itemId] — caja ajusta cantidad o cancela un ítem. */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { itemId } = await ctx.params;
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const item = await actualizarItemCajaPg({
      schema, empresaId: gate.auth.empresa_id, itemId,
      cantidad: o.cantidad != null ? Number(o.cantidad) : undefined,
      cancelar: o.cancelar === true,
    });
    return NextResponse.json(successResponse({ item }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo actualizar el ítem.";
    const status = msg.includes("facturada") || msg.includes("editable") ? 409 : msg.includes("no encontrado") ? 404 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
