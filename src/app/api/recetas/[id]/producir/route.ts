import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getReceta } from "@/lib/recetas/recetas-pg";
import { producirProducto } from "@/lib/recetas/server/consumo-pg";

/**
 * POST /api/recetas/[id]/producir — fabrica el producto de esta receta.
 *
 * Descuenta los insumos y suma el resultado al stock del producto. Solo aplica a
 * productos que llevan stock: lo que se arma al momento del pedido descuenta sus
 * insumos cuando la comanda entra a cocina, no acá.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = tenant.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);
    const { id } = await ctx.params;

    const receta = await getReceta(tenant.supabase, empresaId, id);
    if (!receta) return NextResponse.json(errorResponse("Receta no encontrada."), { status: 404 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const cantidad = Number(body.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return NextResponse.json(errorResponse("La cantidad a producir debe ser mayor a 0."), { status: 400 });
    }

    try {
      const out = await producirProducto(
        schema,
        empresaId,
        (receta as { producto_id: string }).producto_id,
        cantidad,
        { id: tenant.auth.usuarioCatalogId ?? null, nombre: tenant.auth.user?.email ?? null }
      );
      return NextResponse.json(successResponse(out));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudo producir.";
      // Los mensajes de producirProducto ya explican qué falta hacer; se pasan
      // tal cual en vez de esconderlos detrás de un 500 genérico.
      const esDeNegocio = /receta activa|no lleva stock|mayor a 0|no encontrado/i.test(msg);
      return NextResponse.json(errorResponse(msg), { status: esDeNegocio ? 400 : 500 });
    }
  } catch (err) {
    console.error("[/api/recetas/[id]/producir]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo producir."), { status: 500 });
  }
}
