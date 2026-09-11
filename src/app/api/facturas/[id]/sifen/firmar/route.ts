import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { handleSifenFirmarPost } from "@/lib/sifen/handle-sifen-firmar-post";

/**
 * POST /api/facturas/[id]/sifen/firmar
 * Firma el XML en storage con el .p12 de la empresa (XML-DSig). No envía a SET.
 *
 * Resuelve el cliente Supabase con el helper de facturación (PG shim para
 * tenants `erp_*` no expuestos, service role estándar para legacy) y delega
 * en el handler compartido, reutilizable por otros orquestadores.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getFacturasSupabaseFromAuth(request);
  if (!auth) {
    return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
  }
  try {
    return await handleSifenFirmarPost(request, ctx.params, auth.auth, auth.supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
