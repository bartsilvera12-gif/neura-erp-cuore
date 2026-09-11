import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarComandasHistorialPg } from "@/lib/comandas/server/comandas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/**
 * GET /api/comandas/historial — comandas impresas y/o canceladas (no operativas).
 * Filtros: desde, hasta (YYYY-MM-DD), estado (impresa|cancelada), mesa, mozo, numero.
 * Solo mesa — los pedidos Para llevar tienen su propio módulo.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "comandas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const url = new URL(request.url);
    const estadoRaw = url.searchParams.get("estado");
    const estado = estadoRaw === "impresa" || estadoRaw === "cancelada" ? estadoRaw : null;
    const numRaw = url.searchParams.get("numero");
    const mesaRaw = url.searchParams.get("mesa");
    const numero = numRaw && Number.isFinite(Number(numRaw)) ? Number(numRaw) : null;
    const mesa = mesaRaw && Number.isFinite(Number(mesaRaw)) ? Number(mesaRaw) : null;

    const comandas = await listarComandasHistorialPg(schema, auth.empresa_id, {
      desde: url.searchParams.get("desde"),
      hasta: url.searchParams.get("hasta"),
      estado,
      mesa,
      mozo: url.searchParams.get("mozo"),
      numero,
      tipo: "mesa",
    });
    return NextResponse.json(successResponse({ comandas }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cargar el historial de comandas.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
