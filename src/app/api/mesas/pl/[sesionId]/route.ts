import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getParaLlevarDetallePg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/mesas/pl/[sesionId] — detalle (sesión + ítems) de una PL. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { sesionId } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const detalle = await getParaLlevarDetallePg(schema, gate.auth.empresa_id, sesionId);
    if (!detalle) return NextResponse.json(errorResponse("Pedido Para llevar no encontrado."), { status: 404 });
    return NextResponse.json(successResponse({ detalle }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cargar el pedido.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
