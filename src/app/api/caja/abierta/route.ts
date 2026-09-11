import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getCajaAbiertaPg } from "@/lib/caja/server/caja-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/caja/abierta — caja abierta actual de la empresa (o null). */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const caja = await getCajaAbiertaPg(schema, auth.empresa_id);
    return NextResponse.json(successResponse({ caja }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo obtener la caja.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
