import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { cancelarSesionPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/mesas/[id]/cancelar — cancela la cuenta viva (mesa → libre). No factura. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    await cancelarSesionPg(schema, auth.empresa_id, id);
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cancelar la cuenta.";
    const status = msg.includes("no tiene") || msg.includes("ya fue facturada") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
