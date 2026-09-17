import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { eliminarAdicionalPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** DELETE /api/mesas/sesiones/[sesionId]/adicionales/[id] — quita un cargo extra. */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ sesionId: string; id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { id } = await ctx.params;

    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    await eliminarAdicionalPg({ schema, empresaId: gate.auth.empresa_id, adicionalId: id });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo eliminar el adicional.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
