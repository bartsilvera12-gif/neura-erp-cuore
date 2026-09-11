import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { agregarItemPg } from "@/lib/mesas/server/mesas-pg";
import { parseMitadFromBody } from "@/lib/mesas/mitad-parse";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/mesas/[id]/items — agrega un producto a la cuenta (auto-abre sesión). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;

    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const productoId = String(o.producto_id ?? "");
    if (!productoId) return NextResponse.json(errorResponse("producto_id requerido."), { status: 400 });
    const cantidad = Number(o.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return NextResponse.json(errorResponse("Cantidad inválida."), { status: 400 });
    const observacion = o.observacion == null || o.observacion === "" ? null : String(o.observacion).slice(0, 2000);
    const { precioUnitario, displayName, mitad } = parseMitadFromBody(o);

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const item = await agregarItemPg({
      schema, empresaId: auth.empresa_id, mesaId: id,
      productoId, cantidad, observacion, creadoPor: auth.usuarioCatalogId ?? null,
      precioUnitario, displayName, mitad,
    });
    return NextResponse.json(successResponse({ item }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo agregar el producto.";
    const status = msg.includes("enviada a caja") || msg.includes("no encontrado") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
