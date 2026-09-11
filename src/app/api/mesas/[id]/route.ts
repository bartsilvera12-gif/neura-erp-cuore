import { NextRequest, NextResponse } from "next/server";
import { requireModule } from "@/lib/middleware/require-module";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import {
  actualizarMesaPg,
  eliminarMesaDefinitivoPg,
  eliminarMesaPg,
  getMesaDetallePg,
  impactoBorrarMesaPg,
} from "@/lib/mesas/server/mesas-pg";
import { esRolAdminEmpresaOGlobal } from "@/lib/auth/rol-empresa";
import { successResponse, errorResponse } from "@/lib/api/response";

/** GET /api/mesas/[id] — detalle de la mesa: sesión viva + ítems. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    if (request.nextUrl.searchParams.get("impacto") === "1") {
      const impacto = await impactoBorrarMesaPg(schema, auth.empresa_id, id);
      return NextResponse.json(successResponse({ impacto }));
    }
    const detalle = await getMesaDetallePg(schema, auth.empresa_id, id);
    if (!detalle) return NextResponse.json(errorResponse("Mesa no encontrada."), { status: 404 });
    return NextResponse.json(successResponse({ detalle }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cargar la mesa.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * PATCH /api/mesas/[id] — edita número, nombre o alta/baja de la mesa.
 * Solo administradores: renumerar el salón afecta a todos los mozos.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    if (!esRolAdminEmpresaOGlobal(auth.rol)) {
      return NextResponse.json(errorResponse("Sólo un administrador puede editar mesas."), { status: 403 });
    }

    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: { numero?: number; nombre?: string | null; activo?: boolean } = {};
    if (body.numero !== undefined) patch.numero = parseInt(String(body.numero), 10);
    if (body.nombre !== undefined) patch.nombre = body.nombre == null ? null : String(body.nombre);
    if (body.activo !== undefined) patch.activo = body.activo === true;

    const mesa = await actualizarMesaPg(schema, auth.empresa_id, id, patch);
    return NextResponse.json(successResponse({ mesa }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo actualizar la mesa.";
    // Los mensajes de actualizarMesaPg ya son de negocio ("Ya existe la mesa 3").
    const status = /no encontrada/i.test(msg) ? 404 : /ya existe|debe ser/i.test(msg) ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}

/**
 * DELETE /api/mesas/[id] — borra la mesa si nunca se usó.
 *
 * Con historial devuelve 409 y `puede_desactivar`: mesa_sesiones tiene ON DELETE
 * CASCADE, así que borrarla se llevaría sus cuentas, incluidas las facturadas.
 * `?desactivar=1` la da de baja en su lugar.
 */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireModule(request, "mesas");
    if (!gate.ok) return NextResponse.json(errorResponse(gate.error), { status: gate.status });
    const auth = gate.auth;
    if (!esRolAdminEmpresaOGlobal(auth.rol)) {
      return NextResponse.json(errorResponse("Sólo un administrador puede borrar mesas."), { status: 403 });
    }

    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);

    if (request.nextUrl.searchParams.get("desactivar") === "1") {
      const mesa = await actualizarMesaPg(schema, auth.empresa_id, id, { activo: false });
      return NextResponse.json(successResponse({ mesa, desactivada: true }));
    }

    if (request.nextUrl.searchParams.get("forzar") === "1") {
      const impacto = await eliminarMesaDefinitivoPg(schema, auth.empresa_id, id);
      return NextResponse.json(successResponse({ borrada: true, impacto }));
    }

    const out = await eliminarMesaPg(schema, auth.empresa_id, id);
    if (!out.borrada) {
      return NextResponse.json(
        {
          success: false,
          error:
            `Esta mesa ya tiene ${out.sesiones} cuenta${out.sesiones === 1 ? "" : "s"} registrada${out.sesiones === 1 ? "" : "s"}. ` +
            "Borrarla eliminaría ese historial, incluidas las ya facturadas. Podés darla de baja para que deje de aparecer en el salón.",
          puede_desactivar: true,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(successResponse({ borrada: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo borrar la mesa.";
    const status = /no encontrada/i.test(msg) ? 404 : /cuenta abierta|pendiente de cobro/i.test(msg) ? 409 : 500;
    return NextResponse.json(errorResponse(msg), { status });
  }
}
