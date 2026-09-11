import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { toFacturaElectronicaDto } from "@/lib/sifen/to-factura-electronica-dto";
import {
  buildSifenCancelacionPreview,
  normalizePlazoCancelacionHoras,
} from "@/lib/sifen/sifen-cancelacion-rules";
import type { FacturaElectronicaDTO, AmbienteSifen } from "@/lib/sifen/types";
import { downloadSifenCertificadoObject } from "@/lib/sifen/sifen-certificados-storage";
import { decryptSecret } from "@/lib/sifen/security";
import { enviarEventoCancelacionSifen, normalizarMotivoEvento } from "@/lib/sifen/evento-cancelacion";
import { anularVentaPg } from "@/lib/ventas/server/anular-venta-pg";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";

function trimMotivo(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

/**
 * POST /api/facturas/[id]/sifen/cancelar
 * Cancela la factura electrónica ANTE LA SET (evento siRecepEvento) y, solo si
 * la SET registra el evento (dCodRes 0600), la marca cancelada en el ERP y
 * anula la venta origen. Si la SET rechaza, no se toca nada local (el documento
 * sigue vigente para el fisco). No elimina la factura comercial.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const { id } = await params;
    const fid = id?.trim();
    if (!fid) {
      return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("Cuerpo JSON inválido"), { status: 400 });
    }
    const b = body != null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    // Reintento de conciliación con SET: para facturas ya marcadas canceladas
    // localmente pero que NO se cancelaron en SET (bug histórico). Salta el
    // chequeo de "ya cancelado / ventana" local y reenvía el evento a la SET.
    const reintentarSet = b.reintentar_set === true;
    const motivo = trimMotivo(b.motivo);
    if (motivo == null || motivo.length < 5) {
      return NextResponse.json(
        errorResponse("motivo es obligatorio (mínimo 5 caracteres) para registrar la cancelación."),
        { status: 400 }
      );
    }
    if (motivo.length > 2000) {
      return NextResponse.json(errorResponse("motivo no puede superar 2000 caracteres."), { status: 400 });
    }

    const { data: factura, error: errF } = await supabase
      .from("facturas")
      .select("id, empresa_id, origen_venta_id, numero_factura")
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errF) {
      return NextResponse.json(errorResponse(errF.message), { status: 400 });
    }
    if (!factura) {
      return NextResponse.json(errorResponse("Factura no encontrada"), { status: 404 });
    }

    const [{ data: cfg }, { data: feRow }, pagosRes] = await Promise.all([
      supabase
        .from("empresa_sifen_config")
        .select("sifen_plazo_cancelacion_horas")
        .eq("empresa_id", auth.empresa_id)
        .maybeSingle(),
      supabase.from("factura_electronica").select("*").eq("factura_id", fid).eq("empresa_id", auth.empresa_id).maybeSingle(),
      supabase
        .from("pagos")
        .select("id", { count: "exact", head: true })
        .eq("factura_id", fid)
        .eq("empresa_id", auth.empresa_id),
    ]);

    if (pagosRes.error) {
      return NextResponse.json(errorResponse(pagosRes.error.message), { status: 400 });
    }
    const pagosCount = pagosRes.count ?? 0;

    if (!feRow) {
      return NextResponse.json(
        errorResponse("No hay documento electrónico asociado a esta factura."),
        { status: 409 }
      );
    }

    const plazo = normalizePlazoCancelacionHoras(
      cfg != null ? (cfg as { sifen_plazo_cancelacion_horas?: unknown }).sifen_plazo_cancelacion_horas : 48
    );

    const feDto = toFacturaElectronicaDto(feRow as Record<string, unknown>);
    const preview = buildSifenCancelacionPreview({
      estadoSifen: feDto.estado_sifen,
      sifenAprobadoAtIso: feDto.sifen_aprobado_at,
      sifenCanceladoAtIso: feDto.sifen_cancelado_at,
      plazoHoras: plazo,
      pagosCount,
      nowMs: Date.now(),
    });

    if (!preview.puede_cancelar && !reintentarSet) {
      return NextResponse.json(
        errorResponse(preview.motivo_bloqueo ?? "No se puede cancelar el documento electrónico."),
        { status: 409 }
      );
    }

    // ── Cancelación REAL en la SET ───────────────────────────────────────────
    // Se envía el evento de cancelación a la SET y SOLO si la SET lo registra
    // (dCodRes 0600) se marca cancelado en el ERP. Si la SET rechaza (p. ej.
    // fuera del plazo de 48h), NO se toca nada local: el documento sigue vigente
    // para el fisco y decir lo contrario en el ERP sería peor. (Antes esta ruta
    // hacía solo una cancelación LÓGICA local, por eso quedaban vigentes en SET.)
    const cdc = String((feRow as { cdc?: string | null }).cdc ?? "").trim();
    if (cdc.length !== 44) {
      return NextResponse.json(
        errorResponse("La factura no tiene CDC válido; no hay nada que cancelar en la SET."),
        { status: 409 }
      );
    }

    const { data: cfgSet, error: errCfgSet } = await supabase
      .from("empresa_sifen_config")
      .select("ambiente, certificado_path, certificado_password_encrypted")
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    if (errCfgSet || !cfgSet) {
      return NextResponse.json(errorResponse("No hay configuración SIFEN para cancelar en la SET."), { status: 400 });
    }
    const ambiente: AmbienteSifen =
      String((cfgSet as { ambiente?: string }).ambiente ?? "").trim().toLowerCase() === "produccion"
        ? "produccion"
        : "test";
    const certPath = String((cfgSet as { certificado_path?: string | null }).certificado_path ?? "").trim();
    const encPwd = (cfgSet as { certificado_password_encrypted?: unknown }).certificado_password_encrypted;
    if (!certPath || encPwd == null) {
      return NextResponse.json(
        errorResponse("Falta el certificado .p12 o su contraseña en la configuración SIFEN."),
        { status: 400 }
      );
    }
    let p12Password: string;
    try {
      p12Password = decryptSecret(String(encPwd));
    } catch (e) {
      return NextResponse.json(
        errorResponse(e instanceof Error ? e.message : "No se pudo descifrar la contraseña del certificado."),
        { status: 400 }
      );
    }
    const p12Dl = await downloadSifenCertificadoObject(supabase, certPath);
    if (!p12Dl.ok) {
      return NextResponse.json(errorResponse(`No se pudo descargar el certificado .p12: ${p12Dl.message}`), { status: 400 });
    }
    let motivoSet: string;
    try {
      motivoSet = normalizarMotivoEvento(motivo);
    } catch (e) {
      return NextResponse.json(errorResponse(e instanceof Error ? e.message : "Motivo inválido para la SET."), { status: 400 });
    }

    const resp = await enviarEventoCancelacionSifen({
      ambiente,
      cdc,
      motivo: motivoSet,
      certificadoP12: p12Dl.data,
      certificadoPassword: p12Password,
    });

    if (!resp.cancelado) {
      // La SET NO registró la cancelación: no se toca nada local. Se guarda la
      // traza del intento para diagnóstico.
      await supabase.from("factura_electronica_evento").insert({
        empresa_id: auth.empresa_id,
        factura_electronica_id: feDto.id,
        tipo: "cancelacion",
        detalle: {
          origen: "api_cancelar",
          factura_id: fid,
          motivo,
          resultado: "rechazado_set",
          dCodRes: resp.dCodRes,
          dMsgRes: resp.dMsgRes,
          httpStatus: resp.httpStatus,
        },
      });
      return NextResponse.json(
        {
          ...errorResponse(
            resp.dMsgRes?.trim() ||
              (resp.soapFault
                ? "La SET devolvió un SOAP Fault al procesar el evento de cancelación."
                : `La SET no registró la cancelación (HTTP ${resp.httpStatus}). Si venció el plazo de 48h, corresponde emitir una nota de crédito.`)
          ),
          sifen: { dCodRes: resp.dCodRes, dMsgRes: resp.dMsgRes, httpStatus: resp.httpStatus },
        },
        { status: 409 }
      );
    }

    // La SET registró el evento (0600): recién ahora se aplica en el ERP.
    const canceladoEn = new Date().toISOString();

    const { data: updatedFe, error: errUp } = await supabase
      .from("factura_electronica")
      .update({
        estado_sifen: "cancelado",
        sifen_cancelado_at: canceladoEn,
        sifen_cancelacion_motivo: motivo,
      })
      .eq("id", feDto.id)
      .eq("empresa_id", auth.empresa_id)
      .select()
      .single();

    if (errUp || !updatedFe) {
      return NextResponse.json(
        errorResponse(errUp?.message ?? "No se pudo actualizar factura_electronica."),
        { status: 500 }
      );
    }

    const { data: evInsert, error: errEv } = await supabase
      .from("factura_electronica_evento")
      .insert({
        empresa_id: auth.empresa_id,
        factura_electronica_id: feDto.id,
        tipo: "cancelacion",
        detalle: {
          origen: "api_cancelar",
          factura_id: fid,
          motivo,
          cancelado_en: canceladoEn,
          // 4003 → el CDC ya tenía el evento en la SET (reintento / doble clic):
          // el documento está cancelado igual, pero no se registró nada nuevo.
          resultado: resp.yaEstabaCancelado ? "ya_cancelado_set" : "registrado_set",
          dCodRes: resp.dCodRes,
          dMsgRes: resp.dMsgRes,
          response_soap: resp.cuerpoSoapCrudo,
        },
      })
      .select("id")
      .single();

    if (errEv || !evInsert) {
      await supabase
        .from("factura_electronica")
        .update({
          estado_sifen: feDto.estado_sifen,
          sifen_cancelado_at: feDto.sifen_cancelado_at,
          sifen_cancelacion_motivo: feDto.sifen_cancelacion_motivo,
        })
        .eq("id", feDto.id)
        .eq("empresa_id", auth.empresa_id);
      return NextResponse.json(
        errorResponse(`No se pudo registrar el evento; se revirtió el estado: ${errEv?.message ?? "error"}`),
        { status: 500 }
      );
    }

    const { error: errFactura } = await supabase
      .from("facturas")
      .update({ estado: "Anulado", saldo: 0 })
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id);

    if (errFactura) {
      await supabase
        .from("factura_electronica")
        .update({
          estado_sifen: feDto.estado_sifen,
          sifen_cancelado_at: feDto.sifen_cancelado_at,
          sifen_cancelacion_motivo: feDto.sifen_cancelacion_motivo,
        })
        .eq("id", feDto.id)
        .eq("empresa_id", auth.empresa_id);
      await supabase.from("factura_electronica_evento").delete().eq("id", (evInsert as { id: string }).id);
      return NextResponse.json(
        errorResponse(
          `No se pudo anular la factura comercial (${errFactura.message}); se revirtió la cancelación del DE.`
        ),
        { status: 500 }
      );
    }

    // Cancelar el documento en la SET también da de baja la venta que lo
    // originó: devuelve el stock y la saca del arqueo. Best-effort — el DE ya
    // está cancelado en la SET y eso no se puede deshacer, así que un fallo acá
    // se avisa en vez de romper la operación.
    const facturaRow = factura as { origen_venta_id?: string | null; numero_factura?: string };
    let ventaAnuladaOrigenId: string | null = null;
    let ventaAnuladaWarning: string | null = null;
    if (facturaRow.origen_venta_id) {
      try {
        const schemaVenta = await fetchDataSchemaForEmpresaId(auth.empresa_id);
        const res = await anularVentaPg(schemaVenta, auth.empresa_id, {
          ventaId: String(facturaRow.origen_venta_id),
          motivo: `Cancelación SIFEN ${facturaRow.numero_factura ?? ""}: ${motivo}`.trim(),
          usuarioId: auth.usuarioCatalogId ?? null,
          usuarioNombre: auth.user?.email ?? null,
        });
        if (res.ok && !res.yaAnulada) ventaAnuladaOrigenId = String(facturaRow.origen_venta_id);
        else if (!res.ok) ventaAnuladaWarning = res.message;
      } catch (e) {
        ventaAnuladaWarning = `El documento quedó cancelado en la SET, pero no se pudo anular la venta que lo originó: ${
          e instanceof Error ? e.message : String(e)
        }. Anulala a mano desde Ventas.`;
      }
    }

    const dto = toFacturaElectronicaDto(updatedFe as Record<string, unknown>);
    const data: {
      factura_electronica: FacturaElectronicaDTO;
      venta_anulada_id: string | null;
      venta_anulada_warning: string | null;
    } = {
      factura_electronica: dto,
      venta_anulada_id: ventaAnuladaOrigenId,
      venta_anulada_warning: ventaAnuladaWarning,
    };

    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
