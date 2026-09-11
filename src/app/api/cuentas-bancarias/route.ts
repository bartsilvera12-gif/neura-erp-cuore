import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarCuentasBancariasPg } from "@/lib/conciliacion/server/conciliacion-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/cuentas-bancarias — cuentas activas (para el modal de pago en caja). */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const cuentas = await listarCuentasBancariasPg(schema, gate.auth.empresa_id);
    return NextResponse.json(successResponse({ cuentas }));
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error."), { status: 500 });
  }
}
