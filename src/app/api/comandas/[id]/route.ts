import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getComandaDetallePg } from "@/lib/comandas/server/comandas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/comandas/[id] — detalle de una comanda. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "comandas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const comanda = await getComandaDetallePg(schema, auth.empresa_id, id);
    if (!comanda) return NextResponse.json(errorResponse("Comanda no encontrada."), { status: 404 });
    return NextResponse.json(successResponse({ comanda }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cargar la comanda.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
