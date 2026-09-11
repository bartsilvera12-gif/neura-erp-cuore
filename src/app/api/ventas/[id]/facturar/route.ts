import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { facturarVentaPg, FacturarVentaError } from "@/lib/facturacion/server/facturar-venta-pg";
import { encolarEmisionSifen } from "@/lib/sifen/jobs/encolar-emision";

/**
 * POST /api/ventas/[id]/facturar
 *
 * Emite la factura del ERP para una venta ya cobrada. Se llama cuando el
 * cliente pide factura, no en cada venta: ver el porqué en facturar-venta-pg.
 *
 * Devuelve el id de la factura para que la UI lleve al detalle, donde está el
 * panel que firma y envía el documento al SET.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const tenant = await getTenantSupabaseFromAuth(request);
    if (!tenant) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id } = await ctx.params;
    const schema = await fetchDataSchemaForEmpresaId(tenant.auth.empresa_id);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const texto = (v: unknown) =>
      typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 250) : null;

    const ruc = texto(body.ruc);
    const razonSocial = texto(body.razon_social);
    const email = texto(body.email);

    // El local factura siempre a nombre de un contribuyente: sin RUC no hay
    // factura, hay ticket. La regla se valida acá y no sólo en la pantalla
    // porque la pantalla se puede saltear.
    if (!ruc) {
      return NextResponse.json(
        errorResponse("Para facturar hace falta el RUC del cliente."),
        { status: 400 }
      );
    }
    if (!razonSocial) {
      return NextResponse.json(
        errorResponse("Falta la razón social del cliente."),
        { status: 400 }
      );
    }

    const out = await facturarVentaPg(schema, tenant.auth.empresa_id, {
      ventaId: id,
      razonSocial,
      ruc,
      email,
      clienteId: texto(body.cliente_id),
      guardarCliente: body.guardar_cliente === true,
    });

    // Se arranca a emitir acá y no cuando el navegador termine de abrir la
    // pantalla de la factura. Entre confirmar la venta, navegar y montar el
    // panel se perdían varios segundos con el cliente esperando, y parecía que
    // el trámite empezaba de nuevo después de cobrar.
    //
    // Si falla, la factura igual quedó creada y el panel la encola al abrirse,
    // que es lo que hacía antes. Por eso no altera la respuesta.
    const arranque = await encolarEmisionSifen(
      request,
      out.facturaId,
      tenant.auth,
      tenant.supabase
    );
    if (!arranque.encolado) {
      console.info("[facturar] no se pudo arrancar la emisión; la abre el panel", {
        factura_id: out.facturaId,
        motivo: arranque.motivo,
      });
    }

    return NextResponse.json(successResponse(out));
  } catch (err) {
    if (err instanceof FacturarVentaError) {
      return NextResponse.json(
        { success: false, error: err.message, data: { factura_id: err.facturaId } },
        { status: err.codigo === "ya_facturada" ? 409 : 400 }
      );
    }
    console.error("[/api/ventas/[id]/facturar]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo emitir la factura."), { status: 500 });
  }
}
