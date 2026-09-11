import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarComandasPg } from "@/lib/comandas/server/comandas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";
import { ESTADOS_COMANDA, type EstadoComanda } from "@/lib/comandas/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/pedidos-para-llevar?estado= — comandas de sesiones PARA LLEVAR.
 * Espejo de /api/comandas pero filtrando tipo='para_llevar'. Mismos estados.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "comandas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const url = new URL(request.url);
    const estadoRaw = url.searchParams.get("estado");
    const estado = estadoRaw && ESTADOS_COMANDA.includes(estadoRaw as EstadoComanda) ? (estadoRaw as EstadoComanda) : null;
    const comandas = await listarComandasPg(schema, auth.empresa_id, { estado, tipo: "para_llevar" });
    return NextResponse.json(successResponse({ comandas }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudieron cargar los pedidos Para llevar.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
