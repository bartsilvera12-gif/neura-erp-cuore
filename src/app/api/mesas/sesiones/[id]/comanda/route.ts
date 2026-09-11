import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { enviarComandaSesionPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * POST /api/mesas/sesiones/[id]/comanda
 *
 * Manda a cocina los productos pendientes de una cuenta, identificada por la
 * sesión. Lo usa la pantalla de cobro de mesa, que trabaja con el id de sesión
 * y no con el de la mesa: al cobrar se pueden agregar productos y tienen que
 * poder salir a la parrilla sin volver al salón.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id: sesionId } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const envio = await enviarComandaSesionPg(
      schema,
      auth.empresa_id,
      sesionId,
      auth.usuarioCatalogId ?? null
    );
    return NextResponse.json(successResponse(envio));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo enviar la comanda.";
    // 409: no es una falla del servidor sino el estado de la cuenta — no hay
    // nada nuevo que mandar, o ya está facturada.
    const status =
      msg.includes("No hay productos") || msg.includes("no está abierta") || msg.includes("ya fue facturada")
        ? 409
        : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
