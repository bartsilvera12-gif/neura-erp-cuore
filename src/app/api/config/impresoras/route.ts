import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { listarImpresorasPg, guardarImpresoraPg } from "@/lib/impresoras/server/impresoras-pg";
import { successResponse, errorResponse } from "@/lib/api/response";
import type { SectorImpresora } from "@/lib/impresoras/types";

/** GET /api/config/impresoras — lista las 3 impresoras configuradas. */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const items = await listarImpresorasPg(schema, gate.auth.empresa_id);
    return NextResponse.json(successResponse({ impresoras: items }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo listar impresoras.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/** POST /api/config/impresoras — guarda / actualiza la config de un sector. */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });

    let body: unknown = {};
    try { body = await request.json(); } catch { return NextResponse.json(errorResponse("JSON inválido."), { status: 400 }); }
    const o = (body ?? {}) as Record<string, unknown>;
    const sector = String(o.sector ?? "") as SectorImpresora;
    if (!["pizzeria", "plancha", "caja"].includes(sector)) {
      return NextResponse.json(errorResponse("Sector inválido."), { status: 400 });
    }
    const ip = String(o.ip ?? "").trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return NextResponse.json(errorResponse("IP inválida (esperado 192.168.x.y)."), { status: 400 });
    }
    const puerto = Number(o.puerto);
    if (!Number.isFinite(puerto) || puerto <= 0 || puerto > 65535) {
      return NextResponse.json(errorResponse("Puerto inválido."), { status: 400 });
    }
    const nombre = o.nombre == null || o.nombre === "" ? null : String(o.nombre).slice(0, 80);
    const anchoNum = Number(o.ancho_mm);
    const ancho_mm: 58 | 80 = anchoNum === 58 ? 58 : 80;

    const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
    const impresora = await guardarImpresoraPg({
      schema, empresaId: gate.auth.empresa_id,
      sector, ip, puerto, nombre, ancho_mm,
    });
    return NextResponse.json(successResponse({ impresora }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo guardar la impresora.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
