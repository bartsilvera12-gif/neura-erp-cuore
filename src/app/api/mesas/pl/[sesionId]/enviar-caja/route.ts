import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { enviarSesionACajaPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * POST /api/mesas/pl/[sesionId]/enviar-caja
 *
 * Deja el pedido Para llevar en la lista de pendientes de caja. Lo usa el mozo,
 * que no tiene permiso de ventas: es su forma de pasarle el pedido a quien sí
 * cobra. Exige el módulo `mesas`, que es el que el mozo tiene.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { sesionId } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sesion = await enviarSesionACajaPg(schema, auth.empresa_id, sesionId);
    return NextResponse.json(successResponse({ sesion }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo pasar el pedido a caja.";
    // 409: es el estado del pedido, no una falla del servidor.
    const status = msg.includes("no está abierto") || msg.includes("no tiene productos") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
