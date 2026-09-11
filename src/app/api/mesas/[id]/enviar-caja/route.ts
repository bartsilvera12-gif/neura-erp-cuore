import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { enviarACajaPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/mesas/[id]/enviar-caja — marca la cuenta como por_cobrar. NO crea venta. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sesion = await enviarACajaPg(schema, auth.empresa_id, id);
    return NextResponse.json(successResponse({ sesion }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo enviar a caja.";
    const status = msg.includes("no tiene") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
