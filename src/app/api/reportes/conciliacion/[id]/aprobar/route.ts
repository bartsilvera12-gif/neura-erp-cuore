import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { resolverConciliacionPg } from "@/lib/conciliacion/server/conciliacion-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/reportes/conciliacion/[id]/aprobar — marca aprobado (no toca la venta). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "reportes");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const conciliacion = await resolverConciliacionPg({
      schema, empresaId: gate.auth.empresa_id, id, accion: "aprobar", usuarioId: gate.auth.usuarioCatalogId ?? null,
    });
    return NextResponse.json(successResponse({ conciliacion }));
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error."), { status: 500 });
  }
}
