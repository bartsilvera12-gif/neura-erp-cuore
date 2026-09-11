import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { abrirCajaPg } from "@/lib/caja/server/caja-pg";
import { successResponse, errorResponse } from "@/lib/api/response";

/** POST /api/caja/abrir — abre una caja con monto inicial. */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "ventas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const montoApertura = Number(o.monto_apertura);
    if (!Number.isFinite(montoApertura) || montoApertura < 0) {
      return NextResponse.json(errorResponse("Monto de apertura inválido."), { status: 400 });
    }
    const observacion =
      o.observacion == null || o.observacion === "" ? null : String(o.observacion).slice(0, 2000);

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const caja = await abrirCajaPg({
      schema,
      empresaId: auth.empresa_id,
      montoApertura,
      observacion,
      usuarioId: auth.usuarioCatalogId ?? null,
    });
    return NextResponse.json(successResponse({ caja }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo abrir la caja.";
    const status = msg.includes("Ya hay una caja abierta") ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
