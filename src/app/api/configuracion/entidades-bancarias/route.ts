import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listEntidadesPg, createEntidadPg } from "@/lib/configuracion/server/entidades-bancarias-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

export const dynamic = "force-dynamic";

/** GET /api/configuracion/entidades-bancarias?todas=1 — lista de entidades. */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "configuracion");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const todas = new URL(request.url).searchParams.get("todas") === "1";
    const entidades = await listEntidadesPg(schema, gate.auth.empresa_id, todas);
    return NextResponse.json(successResponse({ entidades }));
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error."), { status: 500 });
  }
}

/** POST /api/configuracion/entidades-bancarias — crea una entidad. */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "configuracion");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const entidad = await createEntidadPg(schema, gate.auth.empresa_id, {
      nombre: String(o.nombre ?? ""), banco: o.banco as string | null,
      numero_cuenta: o.numero_cuenta as string | null, tipo: o.tipo as string | null, moneda: o.moneda as string | null,
    });
    return NextResponse.json(successResponse({ entidad }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error.";
    return NextResponse.json(errorResponse(msg), { status: msg.includes("obligatorio") ? 400 : 500 });
  }
}
