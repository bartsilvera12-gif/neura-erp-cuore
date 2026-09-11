import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { abrirMesaPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/mesas/[id]/abrir — abre (o reusa) la cuenta de la mesa. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sesion = await abrirMesaPg(schema, auth.empresa_id, id, auth.usuarioCatalogId ?? null);
    return NextResponse.json(successResponse({ sesion }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo abrir la mesa.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
