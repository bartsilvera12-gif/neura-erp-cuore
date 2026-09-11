import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { agregarItemCajaPg } from "@/lib/mesas/server/mesas-pg";
import { parseMitadFromBody } from "@/lib/mesas/mitad-parse";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/ventas/mesas-por-cobrar/[sesionId]/items — caja agrega un producto a la cuenta. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ sesionId: string }> }) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { sesionId } = await ctx.params;
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const productoId = String(o.producto_id ?? "");
    if (!productoId) return NextResponse.json(errorResponse("producto_id requerido."), { status: 400 });
    const cantidad = Number(o.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return NextResponse.json(errorResponse("Cantidad inválida."), { status: 400 });
    const observacion = o.observacion == null || o.observacion === "" ? null : String(o.observacion).slice(0, 2000);
    const { precioUnitario, displayName, mitad } = parseMitadFromBody(o);

    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const item = await agregarItemCajaPg({
      schema, empresaId: gate.auth.empresa_id, sesionId, productoId, cantidad, observacion,
      cajeroId: gate.auth.usuarioCatalogId ?? null, precioUnitario, displayName, mitad,
    });
    return NextResponse.json(successResponse({ item }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo agregar el producto.";
    const status = msg.includes("facturada") || msg.includes("no encontrada") || msg.includes("editable") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
