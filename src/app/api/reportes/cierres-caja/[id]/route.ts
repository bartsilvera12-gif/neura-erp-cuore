import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getCajaDetallePg } from "@/lib/caja/server/caja-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/reportes/cierres-caja/[id] — detalle de una caja: arqueo + movimientos + ventas. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "reportes");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const detalle = await getCajaDetallePg(schema, auth.empresa_id, id);
    if (!detalle) return NextResponse.json(errorResponse("Caja no encontrada."), { status: 404 });
    return NextResponse.json(successResponse({ detalle }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cargar el detalle de la caja.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
