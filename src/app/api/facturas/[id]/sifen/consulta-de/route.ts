import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { downloadSifenCertificadoObject } from "@/lib/sifen/sifen-certificados-storage";
import { decryptSecret } from "@/lib/sifen/security";
import { consultarDePorCdc } from "@/lib/sifen/consulta-de-por-cdc";
import type { AmbienteSifen } from "@/lib/sifen/types";
import { enviarFacturaMail } from "@/lib/facturacion/server/enviar-factura-mail";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/facturas/[id]/sifen/consulta-de
 *
 * Pregunta a SET por el CDC (siConsDE), NO por el lote. Sirve cuando el lote
 * quedó colgado en 0361 y `consulta-lote` nunca resuelve: el DE puede estar ya
 * aprobado del lado de SET aunque el lote siga trabado.
 *
 * Solo sincroniza el estado local si SET da un veredicto explícito
 * (aprobado / rechazado). Si SET no conoce el CDC o no opina, no se toca nada.
 */
export async function POST(request: NextRequest, { params }: RouteCtx) {
  try {
    const { id } = await params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { auth, supabase } = ctx;

    const { data: fe, error: errFe } = await supabase
      .from("factura_electronica")
      .select("id, factura_id, estado_sifen, cdc, sifen_aprobado_at, sifen_ultima_respuesta_consulta_lote")
      .eq("factura_id", id)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errFe) return NextResponse.json(errorResponse(errFe.message), { status: 400 });
    if (!fe) {
      return NextResponse.json(errorResponse("La factura no tiene documento electrónico."), { status: 404 });
    }

    const cdc = String((fe as { cdc?: string | null }).cdc ?? "").trim();
    if (cdc.length !== 44) {
      return NextResponse.json(
        errorResponse("La factura no tiene CDC válido; no hay nada que consultar."),
        { status: 409 }
      );
    }

    const { data: cfg, error: errCfg } = await supabase
      .from("empresa_sifen_config")
      .select("ambiente, certificado_path, certificado_password_encrypted")
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (errCfg) return NextResponse.json(errorResponse(errCfg.message), { status: 400 });
    if (!cfg) return NextResponse.json(errorResponse("No hay configuración SIFEN."), { status: 400 });

    const ambiente: AmbienteSifen =
      String((cfg as { ambiente?: string }).ambiente ?? "").trim().toLowerCase() === "produccion"
        ? "produccion"
        : "test";

    const certPath = String((cfg as { certificado_path?: string | null }).certificado_path ?? "").trim();
    const encPwd = (cfg as { certificado_password_encrypted?: unknown }).certificado_password_encrypted;
    if (!certPath || encPwd == null) {
      return NextResponse.json(errorResponse("Falta certificado o contraseña en configuración SIFEN."), {
        status: 400,
      });
    }

    let p12Password: string;
    try {
      p12Password = decryptSecret(String(encPwd));
    } catch (e) {
      return NextResponse.json(
        errorResponse(e instanceof Error ? e.message : "No se pudo descifrar la contraseña."),
        { status: 400 }
      );
    }

    const p12Dl = await downloadSifenCertificadoObject(supabase, certPath);
    if (!p12Dl.ok) {
      return NextResponse.json(errorResponse(`No se pudo descargar el .p12: ${p12Dl.message}`), {
        status: 400,
      });
    }

    const resp = await consultarDePorCdc({
      ambiente,
      cdc,
      certificadoP12: p12Dl.data,
      certificadoPassword: p12Password,
    });

    const previo = String((fe as { estado_sifen?: string }).estado_sifen ?? "");
    let estadoNuevo: string | null = null;
    if (resp.aprobado) estadoNuevo = "aprobado";
    else if (resp.rechazado) estadoNuevo = "rechazado";

    // Diagnóstico: guardar lo que SET contestó SIN pisar la respuesta del lote
    // (la UI la usa para mostrar el estado del lote). Se agrega como una clave más.
    const consultaLotePrevia =
      (fe as { sifen_ultima_respuesta_consulta_lote?: unknown }).sifen_ultima_respuesta_consulta_lote;
    const base =
      consultaLotePrevia && typeof consultaLotePrevia === "object" && !Array.isArray(consultaLotePrevia)
        ? (consultaLotePrevia as Record<string, unknown>)
        : {};
    const diagnostico = {
      ...base,
      consulta_de: {
        at: new Date().toISOString(),
        dCodRes: resp.dCodRes,
        dMsgRes: resp.dMsgRes,
        dEstRes: resp.dEstRes,
        dProtAut: resp.dProtAut,
        httpStatus: resp.httpStatus,
        request_soap: resp.requestSoap,
        response_soap: resp.cuerpoSoapCrudo,
      },
    };

    if (estadoNuevo == null || estadoNuevo === previo) {
      await supabase
        .from("factura_electronica")
        .update({ sifen_ultima_respuesta_consulta_lote: diagnostico })
        .eq("id", String((fe as { id: string }).id))
        .eq("empresa_id", auth.empresa_id);

      return NextResponse.json(
        successResponse({
          cambio: false,
          estado_sifen: previo,
          set: {
            dCodRes: resp.dCodRes,
            dMsgRes: resp.dMsgRes,
            dEstRes: resp.dEstRes,
            dProtAut: resp.dProtAut,
            noEncontrado: resp.noEncontrado,
          },
        })
      );
    }

    // SET dio veredicto explícito: sincronizar.
    const update: Record<string, unknown> = {
      estado_sifen: estadoNuevo,
      sifen_ultima_respuesta_consulta_lote: diagnostico,
    };
    if (estadoNuevo === "aprobado") {
      update.error = null;
      if ((fe as { sifen_aprobado_at?: string | null }).sifen_aprobado_at == null) {
        update.sifen_aprobado_at = new Date().toISOString();
      }
    } else {
      update.error =
        resp.dMsgRes == null || String(resp.dMsgRes).trim() === ""
          ? `SET reporta el DE como ${resp.dEstRes ?? "rechazado"}.`
          : `SET: ${String(resp.dMsgRes).trim()}`;
    }

    const { error: errUp } = await supabase
      .from("factura_electronica")
      .update(update)
      .eq("id", String((fe as { id: string }).id))
      .eq("empresa_id", auth.empresa_id);

    if (errUp) {
      return NextResponse.json(
        errorResponse(`SET respondió ${resp.dEstRes}, pero no se pudo actualizar: ${errUp.message}`),
        { status: 500 }
      );
    }

    // La otra puerta por la que un DE pasa a aprobado (la principal es
    // consulta-lote). Si el cliente dejó su correo, acá también se le manda.
    if (estadoNuevo === "aprobado" && previo !== "aprobado") {
      try {
        await enviarFacturaMail({
          supabase,
          empresaId: auth.empresa_id,
          facturaId: id,
          origen: "automatico",
        });
      } catch (e) {
        console.warn("[sifen] excepcion al mandar la factura por correo", {
          factura_id: id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return NextResponse.json(
      successResponse({
        cambio: true,
        estado_sifen_anterior: previo,
        estado_sifen: estadoNuevo,
        set: {
          dCodRes: resp.dCodRes,
          dMsgRes: resp.dMsgRes,
          dEstRes: resp.dEstRes,
          dProtAut: resp.dProtAut,
        },
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/facturas/[id]/sifen/consulta-de]", msg);
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
