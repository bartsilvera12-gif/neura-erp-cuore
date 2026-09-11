import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { abrirSesionParaLlevarPg, listarParaLlevarPg } from "@/lib/mesas/server/mesas-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/mesas/para-llevar — lista sesiones PARA LLEVAR vivas (para sidebar). */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const items = await listarParaLlevarPg(schema, gate.auth.empresa_id);
    return NextResponse.json(successResponse({ items }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo listar Para llevar.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * POST /api/mesas/para-llevar — crea una sesión PARA LLEVAR (sin mesa).
 * Body: { nombre_cliente?: string, observacion?: string }. Devuelve { sesion }.
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    let body: unknown = {};
    try { body = await request.json(); } catch { /* body opcional */ }
    const o = (body ?? {}) as Record<string, unknown>;
    const nombreCliente = o.nombre_cliente == null || o.nombre_cliente === "" ? null : String(o.nombre_cliente).slice(0, 120);
    // Nota del pedido: la lee cocina en la comanda (ej. "delivery", "retira 21hs").
    const observacion = o.observacion == null || o.observacion === "" ? null : String(o.observacion).slice(0, 200);

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sesion = await abrirSesionParaLlevarPg(schema, auth.empresa_id, auth.usuarioCatalogId ?? null, nombreCliente, observacion);
    return NextResponse.json(successResponse({ sesion }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo crear la sesión Para llevar.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
