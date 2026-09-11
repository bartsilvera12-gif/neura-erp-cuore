import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarConciliacionPg, listarCuentasBancariasPg } from "@/lib/conciliacion/server/conciliacion-pg";
import { successResponse, errorResponse } from "@/lib/api/response";
import type { ConciliacionEstado, MedioConciliacion } from "@/lib/conciliacion/types";

export const dynamic = "force-dynamic";

/** GET /api/reportes/conciliacion — pagos transferencia/tarjeta + resumen + cuentas (para filtros). */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "reportes");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const u = new URL(request.url);
    const estadoRaw = u.searchParams.get("estado");
    const medioRaw = u.searchParams.get("medio_pago");
    const { items, resumen } = await listarConciliacionPg(schema, gate.auth.empresa_id, {
      desde: u.searchParams.get("desde"),
      hasta: u.searchParams.get("hasta"),
      estado: (["pendiente", "aprobado", "rechazado"].includes(estadoRaw ?? "") ? estadoRaw : null) as ConciliacionEstado | null,
      medio_pago: (["transferencia", "tarjeta"].includes(medioRaw ?? "") ? medioRaw : null) as MedioConciliacion | null,
      cuenta_bancaria_id: u.searchParams.get("cuenta_bancaria_id"),
      caja_id: u.searchParams.get("caja_id"),
    });
    const cuentas = await listarCuentasBancariasPg(schema, gate.auth.empresa_id);
    return NextResponse.json(successResponse({ items, resumen, cuentas }));
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error."), { status: 500 });
  }
}
