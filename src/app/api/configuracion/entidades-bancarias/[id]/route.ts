import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { updateEntidadPg, eliminarEntidadPg } from "@/lib/configuracion/server/entidades-bancarias-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** PATCH /api/configuracion/entidades-bancarias/[id] — edita o (des)activa. */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "configuracion");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { id } = await ctx.params;
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const entidad = await updateEntidadPg(schema, gate.auth.empresa_id, id, {
      nombre: o.nombre !== undefined ? String(o.nombre) : undefined,
      banco: o.banco !== undefined ? (o.banco as string | null) : undefined,
      numero_cuenta: o.numero_cuenta !== undefined ? (o.numero_cuenta as string | null) : undefined,
      tipo: o.tipo !== undefined ? (o.tipo as string | null) : undefined,
      moneda: o.moneda !== undefined ? (o.moneda as string | null) : undefined,
      activo: typeof o.activo === "boolean" ? o.activo : undefined,
    });
    return NextResponse.json(successResponse({ entidad }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error.";
    return NextResponse.json(errorResponse(msg), { status: msg.includes("no encontrada") ? 404 : msg.includes("vacío") || msg.includes("Nada") ? 400 : 500 });
  }
}

/** DELETE /api/configuracion/entidades-bancarias/[id] — borra si no tiene conciliaciones; si tiene, desactiva. */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "configuracion");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const r = await eliminarEntidadPg(schema, gate.auth.empresa_id, id);
    return NextResponse.json(successResponse(r));
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error."), { status: 500 });
  }
}
