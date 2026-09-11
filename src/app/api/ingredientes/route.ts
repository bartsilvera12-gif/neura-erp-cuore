import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId, createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";

/**
 * GET /api/ingredientes — catálogo global de ingredientes de la empresa.
 *
 * Se usa desde el modal de personalización de pizza para armar los chips de
 * "Agregar" y "Sin …". Devuelve sólo los activos, alfabéticos.
 */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const sb = createServiceRoleClientWithDbSchema(schema);

    const q = await sb
      .from("ingredientes")
      .select("id, nombre, precio")
      .eq("empresa_id", auth.empresa_id)
      .eq("activo", true)
      .order("nombre", { ascending: true });

    if (q.error) return NextResponse.json(errorResponse(q.error.message), { status: 500 });

    return NextResponse.json(successResponse({
      ingredientes: (q.data ?? []) as Array<{ id: string; nombre: string; precio: number }>,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cargar el catálogo de ingredientes.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
