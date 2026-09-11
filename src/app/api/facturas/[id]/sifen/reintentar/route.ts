import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { enqueueSifenJob } from "@/lib/sifen/jobs/sifen-jobs-repo";

/**
 * POST /api/facturas/[id]/sifen/reintentar
 *
 * Inserta un nuevo `sifen_job` con origen='reintento_manual' cuando el DE está
 * en un estado intermedio o rechazado. Nunca se re-emite un DE ya aprobado.
 *
 * Estados aceptados: 'borrador' | 'generado' | 'firmado' | 'error_envio' | 'rechazado'.
 * Estados rechazados: 'aprobado' | 'cancelado' | 'enviado' | 'en_proceso'.
 *  - 'aprobado' / 'cancelado': terminal.
 *  - 'enviado' / 'en_proceso': hay que consultar-lote, no re-enviar.
 *
 * La unicidad parcial en `sifen_jobs` evita duplicar un Job vivo; si el operador
 * apreta "Reintentar" con otro Job aún corriendo, se devuelve el job existente.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const auth = await getFacturasSupabaseFromAuth(request);
    if (!auth) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { id } = await ctx.params;
    const facturaId = id?.trim();
    if (!facturaId) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    const { data: fe, error: errFe } = await auth.supabase
      .from("factura_electronica")
      .select("id, estado_sifen")
      .eq("factura_id", facturaId)
      .eq("empresa_id", auth.auth.empresa_id)
      .maybeSingle();
    if (errFe) {
      return NextResponse.json(errorResponse(errFe.message), { status: 400 });
    }
    if (!fe) {
      return NextResponse.json(
        errorResponse("No hay documento electrónico para reintentar. Encolá primero desde la venta."),
        { status: 404 }
      );
    }

    const st = String(fe.estado_sifen ?? "");
    if (st === "aprobado") {
      return NextResponse.json(
        errorResponse("El documento ya está aprobado por SET; no se re-emite."),
        { status: 409 }
      );
    }
    if (st === "cancelado") {
      return NextResponse.json(
        errorResponse("El documento está cancelado en el ERP; no se puede reintentar."),
        { status: 409 }
      );
    }
    if (st === "enviado" || st === "en_proceso") {
      return NextResponse.json(
        errorResponse(
          "El lote ya está enviado a SET. Usá «Consultar lote» para actualizar el resultado en lugar de reintentar."
        ),
        { status: 409 }
      );
    }

    const enq = await enqueueSifenJob(auth.supabase, {
      empresaId: auth.auth.empresa_id,
      facturaId,
      facturaElectronicaId: String(fe.id),
      origen: "reintento_manual",
    });
    if (!enq.ok) {
      return NextResponse.json(errorResponse(enq.message), { status: enq.status });
    }

    return NextResponse.json(
      successResponse({
        started: true,
        job_id: enq.job.id,
        ya_habia_activo: enq.ya_habia_activo,
        factura_electronica_id: String(fe.id),
        at: new Date().toISOString(),
      }),
      { status: 202 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
