import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getSesionDetallePg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/ventas/mesas-por-cobrar/[sesionId] — detalle de la cuenta para que caja la edite. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { sesionId } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const detalle = await getSesionDetallePg(schema, gate.auth.empresa_id, sesionId);
    if (!detalle) return NextResponse.json(errorResponse("Sesión no encontrada."), { status: 404 });
    return NextResponse.json(successResponse({ detalle }));
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error."), { status: 500 });
  }
}
