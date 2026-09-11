import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { crearMesasPg, listarMesasPg, ultimoNumeroMesaPg } from "@/lib/mesas/server/mesas-pg";
import { esRolAdminEmpresaOGlobal } from "@/lib/auth/rol-empresa";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/mesas — todas las mesas con el resumen de su sesión viva. */
export async function GET(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    // Solo el salón necesita ocultar las dadas de baja; la pantalla de
    // administración las pide para poder reactivarlas.
    const incluirInactivas = request.nextUrl.searchParams.get("incluirInactivas") === "1";
    const mesas = await listarMesasPg(schema, auth.empresa_id, incluirInactivas);
    const ultimoNumero = await ultimoNumeroMesaPg(schema, auth.empresa_id);
    return NextResponse.json(successResponse({ mesas, ultimoNumero }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudieron cargar las mesas.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * POST /api/mesas — alta de mesas por rango.
 *
 * Body: { desde: number, cantidad: number, nombre?: string }
 *
 * Dar de alta mesas es configurar el salón, no operarlo: se restringe a
 * administradores, aunque un mozo tenga acceso al módulo `mesas` para tomar
 * pedidos.
 */
export async function POST(request: NextRequest) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;

    if (!esRolAdminEmpresaOGlobal(auth.rol)) {
      return NextResponse.json(
        errorResponse("Sólo un administrador puede crear mesas."),
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { desde?: unknown; cantidad?: unknown; nombre?: unknown }
      | null;
    if (!body) return NextResponse.json(errorResponse("Body inválido."), { status: 400 });

    const desde = Number(body.desde);
    const cantidad = Number(body.cantidad);
    const nombre = typeof body.nombre === "string" ? body.nombre : null;

    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const res = await crearMesasPg(schema, auth.empresa_id, desde, cantidad, nombre);
    return NextResponse.json(successResponse(res));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudieron crear las mesas.";
    return NextResponse.json(errorResponse(msg), { status: 400 });
  }
}
