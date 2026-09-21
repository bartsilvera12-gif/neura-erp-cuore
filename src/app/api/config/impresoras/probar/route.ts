import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getImpresoraPorSectorPg } from "@/lib/impresoras/server/impresoras-pg";
import { enviarTcp, ticketPrueba } from "@/lib/impresoras/server/escpos";
import { successResponse, errorResponse } from "@/lib/api/response";
import { SECTOR_LABEL, type SectorImpresora } from "@/lib/impresoras/types";

/**
 * POST /api/config/impresoras/probar
 * Body: { sector }  o  { ip, puerto }
 *
 * Manda un ticket de prueba a la impresora del sector indicado. Si vienen
 * IP + puerto en el body, usa esos directamente en vez de leer la config
 * guardada (útil para probar antes de guardar).
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });

    let body: unknown = {};
    try { body = await request.json(); } catch { /* body opcional */ }
    const o = (body ?? {}) as Record<string, unknown>;
    const sector = String(o.sector ?? "") as SectorImpresora;
    if (!["pizzeria", "plancha", "caja"].includes(sector)) {
      return NextResponse.json(errorResponse("Sector inválido."), { status: 400 });
    }

    let ip = String(o.ip ?? "").trim();
    let puerto = Number(o.puerto);
    if (!ip || !Number.isFinite(puerto) || puerto <= 0) {
      // Sin datos en el body → usar la config guardada.
      const schema = await fetchDataSchemaForEmpresaId(gate.auth.empresa_id);
      const cfg = await getImpresoraPorSectorPg(schema, gate.auth.empresa_id, sector);
      if (!cfg) return NextResponse.json(errorResponse("No hay impresora configurada para ese sector."), { status: 400 });
      ip = cfg.ip;
      puerto = cfg.puerto;
    }

    await enviarTcp(ip, puerto, ticketPrueba(SECTOR_LABEL[sector]));
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo enviar el ticket de prueba.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
