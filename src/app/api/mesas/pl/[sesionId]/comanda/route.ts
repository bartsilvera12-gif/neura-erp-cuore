import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { enviarComandaSesionPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/mesas/pl/[sesionId]/comanda — envía pendientes de una PL a cocina. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { sesionId } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const envio = await enviarComandaSesionPg(schema, auth.empresa_id, sesionId, auth.usuarioCatalogId ?? null);
    return NextResponse.json(successResponse(envio));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo enviar la comanda.";
    const status = msg.includes("No hay productos") || msg.includes("no está abierta") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
