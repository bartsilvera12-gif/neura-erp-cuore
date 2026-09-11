import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { cancelarSesionPLPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/mesas/pl/[sesionId]/cancelar — cancela una cuenta PL viva. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { sesionId } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    await cancelarSesionPLPg(schema, gate.auth.empresa_id, sesionId);
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cancelar.";
    const status = msg.includes("facturada") || msg.includes("no existe") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
