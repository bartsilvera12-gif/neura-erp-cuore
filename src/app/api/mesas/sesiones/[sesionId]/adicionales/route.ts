import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { agregarAdicionalPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * POST /api/mesas/sesiones/[sesionId]/adicionales
 * Body: { monto: number, descripcion?: string }
 * Devuelve { adicional }.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { sesionId } = await ctx.params;

    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const monto = Number(o.monto);
    if (!Number.isFinite(monto) || monto <= 0) {
      return NextResponse.json(errorResponse("Monto inválido."), { status: 400 });
    }
    const descripcion = o.descripcion == null || o.descripcion === "" ? null : String(o.descripcion).slice(0, 200);

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const adicional = await agregarAdicionalPg({
      schema, empresaId: auth.empresa_id, sesionId,
      monto, descripcion, creadoPor: auth.usuarioCatalogId ?? null,
    });
    return NextResponse.json(successResponse({ adicional }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo agregar el adicional.";
    const status = msg.includes("facturada") || msg.includes("no acepta") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
