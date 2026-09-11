import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { registrarImpresionPg } from "@/lib/comandas/server/comandas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/comandas/[id]/imprimir — registra una impresión (print_count++, estado=impresa). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "comandas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const comanda = await registrarImpresionPg(schema, auth.empresa_id, id, auth.usuarioCatalogId ?? null);
    return NextResponse.json(successResponse({ comanda }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo registrar la impresión.";
    const status = msg.includes("no encontrada") ? 404 : msg.includes("cancelada") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
