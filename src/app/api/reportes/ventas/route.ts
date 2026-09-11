import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { reporteVentas, esModalidad } from "@/lib/ventas/server/reporte-ventas-pg";

/** Acepta solo YYYY-MM-DD; cualquier otra cosa se ignora en vez de romper. */
function fecha(v: string | null): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * GET /api/reportes/ventas?desde=&hasta=&modalidad=&anuladas=1
 * Ventas del período con el corte por modalidad (salón, delivery, retiro…),
 * método de pago, día y producto.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id);

    const sp = request.nextUrl.searchParams;
    const modalidadRaw = (sp.get("modalidad") ?? "").trim();

    const data = await reporteVentas(schema, tenant.auth.empresa_id, {
      desde: fecha(sp.get("desde")),
      hasta: fecha(sp.get("hasta")),
      modalidad: esModalidad(modalidadRaw) ? modalidadRaw : null,
      incluirAnuladas: sp.get("anuladas") === "1",
    });

    return NextResponse.json(successResponse(data));
  } catch (err) {
    console.error("[/api/reportes/ventas]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo generar el reporte de ventas."), { status: 500 });
  }
}
