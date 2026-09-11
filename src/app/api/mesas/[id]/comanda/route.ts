import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { enviarComandaPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * POST /api/mesas/[id]/comanda — envía los ítems pendientes a cocina como una
 * comanda. La mesa sigue ocupada. NO crea venta ni manda a por_cobrar.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const envio = await enviarComandaPg(schema, auth.empresa_id, id, auth.usuarioCatalogId ?? null);
    return NextResponse.json(successResponse(envio));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo enviar la comanda.";
    const status = msg.includes("No hay productos nuevos") || msg.includes("no tiene") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
