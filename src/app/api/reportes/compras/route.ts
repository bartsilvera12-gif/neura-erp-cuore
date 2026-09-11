import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { reporteCompras } from "@/lib/compras/server/compras-pg";

/** Acepta solo YYYY-MM-DD; cualquier otra cosa se ignora en vez de romper. */
function fecha(v: string | null): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * GET /api/reportes/compras?desde=&hasta=&proveedor=
 * Agregados de compras por proveedor, producto y día, más el detalle.
 */
export async function GET(request: NextRequest) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id);

    const sp = request.nextUrl.searchParams;
    const proveedor = sp.get("proveedor");

    const data = await reporteCompras(schema, tenant.auth.empresa_id, {
      desde: fecha(sp.get("desde")),
      hasta: fecha(sp.get("hasta")),
      proveedorId: proveedor && proveedor.trim() !== "" ? proveedor : null,
    });

    return NextResponse.json(successResponse(data));
  } catch (err) {
    console.error("[/api/reportes/compras]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo generar el reporte de compras."), { status: 500 });
  }
}
