import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { handleSifenBorradorPost } from "@/lib/sifen/handle-sifen-borrador-post";
import { enqueueSifenJob } from "@/lib/sifen/jobs/sifen-jobs-repo";
import type { FacturaElectronicaDTO } from "@/lib/sifen/types";

/**
 * POST /api/facturas/[id]/sifen/encolar
 *
 * Fase 2 del rediseño async: en vez de correr borrador → xml → firmar → enviar
 * cliente-side (30-35s bloqueando la caja) o server-side vía loopback HTTP (que
 * rompía auth y facturaba con otra empresa), este endpoint:
 *
 *   1) Asegura que exista `factura_electronica` en 'borrador' (usando el mismo
 *      handler que POST .../sifen/borrador — cero cambio semántico).
 *   2) Inserta un `sifen_job` en estado 'pendiente'.
 *   3) Responde 202 { started, job_id, ya_habia_activo } inmediatamente.
 *
 * El worker (Fase 3) toma el job y ejecuta xml/firmar/enviar/consulta_lote
 * llamando DIRECTAMENTE las funciones del server (sin fetch loopback, sin
 * cookies, sin Bearer). Congelamos `empresa_id` + `data_schema` en el Job
 * para eliminar la re-resolución de tenant que fue la causa del bug anterior.
 *
 * Doble-clic / refresh del panel: la unicidad parcial en sifen_jobs
 * (WHERE estado IN ('pendiente','procesando')) garantiza un solo Job vivo por
 * DE; el segundo request devuelve el job existente sin duplicar.
 *
 * Si el DE está en estado terminal ('aprobado' / 'cancelado'), no se encola —
 * se responde el estado actual para que la UI simplemente muestre el resultado.
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

    // 1) Asegurar borrador reutilizando el handler HTTP-shape. Si ya existe,
    //    devuelve el registro tal cual (idempotente). Si SIFEN no está
    //    configurado/activo, replicamos el mismo error 400 que devuelve el
    //    endpoint /borrador — la UI ya sabe manejarlo.
    const paramsSingleUse = ctx.params;
    const borradorRes = await handleSifenBorradorPost(
      request,
      paramsSingleUse,
      auth.auth,
      auth.supabase
    );
    if (!borradorRes.ok) {
      // Propagamos status y body para preservar el contrato de errores.
      const body = (await borradorRes.json()) as { error?: string };
      return NextResponse.json(
        errorResponse(body.error ?? "No se pudo asegurar el borrador."),
        { status: borradorRes.status }
      );
    }
    const borradorJson = (await borradorRes.json()) as {
      success?: boolean;
      data?: FacturaElectronicaDTO;
      error?: string;
    };
    const fe = borradorJson.data;
    if (!borradorJson.success || !fe) {
      return NextResponse.json(
        errorResponse(borradorJson.error ?? "Respuesta inválida al asegurar el borrador."),
        { status: 500 }
      );
    }

    const st = String(fe.estado_sifen ?? "");
    if (st === "aprobado" || st === "cancelado") {
      return NextResponse.json(
        successResponse({
          started: false,
          estado_terminal: st,
          factura_electronica_id: fe.id,
        })
      );
    }

    const enq = await enqueueSifenJob(auth.supabase, {
      empresaId: auth.auth.empresa_id,
      facturaId,
      facturaElectronicaId: fe.id,
      origen: "auto_venta",
    });
    if (!enq.ok) {
      return NextResponse.json(errorResponse(enq.message), { status: enq.status });
    }

    return NextResponse.json(
      successResponse({
        started: true,
        job_id: enq.job.id,
        ya_habia_activo: enq.ya_habia_activo,
        factura_electronica_id: fe.id,
        at: new Date().toISOString(),
      }),
      { status: 202 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
