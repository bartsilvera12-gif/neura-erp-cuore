import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarPorCobrarPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/mesas/por-cobrar — mesas con cuenta enviada a caja (para facturar). */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const mesas = await listarPorCobrarPg(schema, auth.empresa_id);
    return NextResponse.json(successResponse({ mesas }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudieron cargar las mesas por cobrar.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
