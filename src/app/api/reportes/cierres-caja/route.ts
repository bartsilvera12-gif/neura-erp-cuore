import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarCajasPg } from "@/lib/caja/server/caja-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * GET /api/reportes/cierres-caja — listado de cajas (turnos) con sus totales.
 * Reusa listarCajasPg; el filtrado por fecha/estado lo hace el cliente.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "reportes");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const cajas = await listarCajasPg(schema, auth.empresa_id, 300);
    return NextResponse.json(successResponse({ cajas }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudieron cargar los cierres de caja.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
