import { NextRequest, NextResponse } from "next/server";
import type { UsuarioConEmpresa } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { decryptSecret } from "@/lib/sifen/security";
import { enviarLoteSifen, type RecibeLoteRespuestaParsed } from "@/lib/sifen/enviar-lote-sifen-test";
import { recibirDeSifenSync } from "@/lib/sifen/recibe-de-sifen-test";
import { downloadSifenObject, SIFEN_STORAGE_BUCKET } from "@/lib/sifen/sifen-storage";
import { downloadSifenCertificadoObject } from "@/lib/sifen/sifen-certificados-storage";
import { toFacturaElectronicaDto } from "@/lib/sifen/to-factura-electronica-dto";
import type { AmbienteSifen, SifenApiEnviarTestDetalle, SifenEnviarTestResponseData } from "@/lib/sifen/types";
import { isExplicitSifenTestOverrideEnabled } from "@/lib/env/allow-test-mode";
import { enviarDeSincronico } from "@/lib/sifen/envio-sincronico";
import { enviarFacturaMail } from "@/lib/facturacion/server/enviar-factura-mail";

function parseAmbiente(raw: string): AmbienteSifen | null {
  if (raw === "test" || raw === "produccion") return raw;
  return null;
}

function decodificarEntidadesSoapBasicas(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(String(n), 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function respuestaRecibeLoteJson(r: RecibeLoteRespuestaParsed): Record<string, unknown> {
  return {
    dCodRes: r.dCodRes,
    dMsgRes: r.dMsgRes,
    dProtConsLote: r.dProtConsLote,
    dFecProc: r.dFecProc,
    dTpoProces: r.dTpoProces,
    loteRecibido: r.loteRecibido,
    loteNoEncolado: r.loteNoEncolado,
    httpStatus: r.httpStatus,
    cuerpoSoapCrudo: r.cuerpoSoapCrudo,
  };
}

export type HandleSifenEnviarPostOptions = {
  /** Si true, solo permite `empresa_sifen_config.ambiente === "test"` (compat. `/sifen/enviar-test`). */
  soloAmbienteTest: boolean;
};

/**
 * POST recibe-lote según ambiente en BD (test | producción), salvo `soloAmbienteTest`.
 *
 * El cliente Supabase se recibe por parámetro para que la ruta decida si va por
 * PostgREST (legacy `zentra_erp`) o por el PG shim (tenants `erp_*` no expuestos).
 * Antes este handler hacía `createServiceRoleClientForEmpresa` adentro, lo que
 * dejaba a tenants `erp_*` con `PGRST106 Invalid schema`.
 */
export async function handleSifenEnviarPost(
  request: NextRequest,
  params: Promise<{ id: string }>,
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient,
  options: HandleSifenEnviarPostOptions
): Promise<NextResponse> {
  const debugSoap = request.nextUrl.searchParams.get("debug") === "1";
  const { id: facturaId } = await params;
  if (!facturaId?.trim()) {
    return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
  }
  const fid = facturaId.trim();

  const { data: feRow, error: errFe } = await supabase
    .from("factura_electronica")
    .select(
      "id, factura_id, estado_sifen, cdc, xml_firmado_path, error, sifen_d_prot_cons_lote, sifen_ultima_respuesta_recibe_lote, sifen_ultima_respuesta_consulta_lote"
    )
    .eq("factura_id", fid)
    .eq("empresa_id", auth.empresa_id)
    .maybeSingle();

  if (errFe) {
    return NextResponse.json(errorResponse(errFe.message), { status: 400 });
  }
  if (!feRow) {
    return NextResponse.json(errorResponse("No existe registro electrónico para esta factura."), {
      status: 400,
    });
  }

  if (String(feRow.estado_sifen) !== "firmado") {
    return NextResponse.json(
      errorResponse(
        `Solo se puede enviar a SET con estado "firmado". Estado actual: "${feRow.estado_sifen}".`
      ),
      { status: 409 }
    );
  }

  const signedPath = feRow.xml_firmado_path == null ? "" : String(feRow.xml_firmado_path).trim();
  if (!signedPath) {
    return NextResponse.json(
      errorResponse("No hay XML firmado (xml_firmado_path vacío). Ejecute primero POST .../sifen/firmar."),
      { status: 400 }
    );
  }

  const { data: cfg, error: errCfg } = await supabase
    .from("empresa_sifen_config")
    .select("ambiente, activo, certificado_path, certificado_password_encrypted")
    .eq("empresa_id", auth.empresa_id)
    .maybeSingle();

  if (errCfg) {
    return NextResponse.json(errorResponse(errCfg.message), { status: 400 });
  }
  if (!cfg) {
    return NextResponse.json(errorResponse("No hay configuración SIFEN para esta empresa."), {
      status: 400,
    });
  }

  const ambiente = parseAmbiente(String(cfg.ambiente ?? ""));
  if (!ambiente) {
    return NextResponse.json(errorResponse('Ambiente SIFEN inválido en configuración (use "test" o "produccion").'), {
      status: 400,
    });
  }

  if (options.soloAmbienteTest && ambiente !== "test" && !isExplicitSifenTestOverrideEnabled()) {
    return NextResponse.json(
      errorResponse(
        'Este endpoint solo opera con configuración SIFEN en ambiente "test", o bien con ALLOW_TEST_MODE=true en el servidor (SOAP a SET TEST). Use POST .../sifen/enviar para producción real.'
      ),
      { status: 400 }
    );
  }

  const ambienteSoap: AmbienteSifen = options.soloAmbienteTest ? "test" : ambiente;

  if (!cfg.activo) {
    return NextResponse.json(
      errorResponse("La configuración SIFEN está inactiva. Actívela antes de enviar."),
      { status: 400 }
    );
  }

  const certPath = cfg.certificado_path == null ? "" : String(cfg.certificado_path).trim();
  if (!certPath) {
    return NextResponse.json(
      errorResponse("No hay certificado en storage. Suba el .p12 en configuración SIFEN."),
      { status: 400 }
    );
  }

  const encPwd = cfg.certificado_password_encrypted;
  if (encPwd == null || String(encPwd).trim() === "") {
    return NextResponse.json(
      errorResponse("Falta la contraseña del certificado cifrada en configuración SIFEN."),
      { status: 400 }
    );
  }

  let p12Password: string;
  try {
    p12Password = decryptSecret(String(encPwd));
  } catch (e) {
    const m = e instanceof Error ? e.message : "Error al descifrar la contraseña del certificado";
    return NextResponse.json(errorResponse(m), { status: 500 });
  }

  // Cronometrado por tramo para poder responder con datos, y no con
  // impresiones, qué parte del envío es nuestra y cuál es del SET.
  const tDescargas = Date.now();
  const xmlDl = await downloadSifenObject(supabase, signedPath);
  if (!xmlDl.ok) {
    return NextResponse.json(
      errorResponse(`No se pudo descargar el XML firmado: ${xmlDl.message}`),
      { status: 500 }
    );
  }

  const msXml = Date.now() - tDescargas;
  const tCert = Date.now();
  const p12Dl = await downloadSifenCertificadoObject(supabase, certPath);
  if (!p12Dl.ok) {
    return NextResponse.json(
      errorResponse(`No se pudo descargar el certificado .p12: ${p12Dl.message}`),
      { status: 500 }
    );
  }

  // ── Candado: un solo envío por documento ───────────────────────────────────
  //
  // La comprobación de "estado = firmado" de más arriba no alcanza cuando dos
  // llamadas entran a la vez: las dos leen "firmado" y las dos salen a enviar.
  // Pasó de verdad — el primer envío entró y el segundo volvió como «lote no
  // encolado», que en pantalla se ve como un rechazo del SET aunque la factura
  // estuviera perfecta.
  //
  // El paso a "enviado" se hace acá, condicionado a que siga en "firmado". Si
  // no actualiza ninguna fila es porque otro ya está enviando, y entonces este
  // se retira sin tocar al SET. La condición la resuelve la base sobre la fila
  // bloqueada, así que no hay ventana entre leer y escribir.
  const { data: claim } = await supabase
    .from("factura_electronica")
    .update({ estado_sifen: "enviado" })
    .eq("id", feRow.id)
    .eq("empresa_id", auth.empresa_id)
    .eq("estado_sifen", "firmado")
    .select("id")
    .maybeSingle();

  if (!claim) {
    return NextResponse.json(
      errorResponse("Este documento ya se está enviando al SET. Esperá el resultado."),
      { status: 409 }
    );
  }

  // ── Vía rápida: el canal sincrónico del SET ────────────────────────────────
  //
  // Contesta aprobado o rechazado en la misma llamada, así que la factura queda
  // resuelta en segundos en vez de esperar la escalera de consultas del lote.
  //
  // Si no puede resolver, cae al camino de lote de siempre, que queda intacto
  // más abajo. Nunca reintenta a ciegas: ante una respuesta ambigua le pregunta
  // al SET por el CDC, porque mandar dos veces el mismo documento lo haría
  // rechazar por duplicado.
  //
  // Viene apagado. El SET habilita la recepción sincrónica por separado de la
  // de lote, y si el RUC no la tiene, contesta 1264 («no está habilitado para
  // utilizar este tipo de servicio») a cada intento. Medido: el envío pasaba de
  // ~3s a ~9s, porque se pagaba el sincrónico rechazado y después el lote.
  //
  // Cuando el contador habilite el servicio en Marangatú, se prende con
  // `SIFEN_ENVIO_SINCRONICO=1` y la factura resuelve en una sola llamada, sin
  // la consulta de lote que hoy agrega unos 6 segundos.
  const cdcActual = feRow.cdc == null ? "" : String(feRow.cdc).trim();
  if (process.env.SIFEN_ENVIO_SINCRONICO === "1" && cdcActual.length === 44) {
    const rapido = await enviarDeSincronico({
      xmlFirmadoRde: xmlDl.data.toString("utf8"),
      cdc: cdcActual,
      ambiente: ambienteSoap,
      certificadoP12: p12Dl.data,
      certificadoPassword: p12Password,
    });

    if (rapido.tipo === "resuelto") {
      const aprobado = rapido.estado === "aprobado";
      const { data: filaSync, error: errSync } = await supabase
        .from("factura_electronica")
        .update({
          estado_sifen: rapido.estado,
          error: aprobado ? null : rapido.mensaje ?? "SET rechazó el documento.",
          // Sin lote no hay protocolo de lote; el número de autorización va en
          // el detalle por CDC, que es de donde lo lee el KUDE.
          sifen_d_prot_cons_lote: null,
          sifen_ultima_respuesta_consulta_lote: rapido.persistible,
          ...(aprobado ? { sifen_aprobado_at: new Date().toISOString() } : {}),
        })
        .eq("id", feRow.id)
        .eq("empresa_id", auth.empresa_id)
        .select()
        .single();

      if (!errSync && filaSync) {
        await supabase.from("factura_electronica_evento").insert({
          empresa_id: auth.empresa_id,
          factura_electronica_id: feRow.id,
          tipo: "respuesta",
          detalle: {
            origen: "api_enviar_sincronico",
            factura_id: fid,
            estado_sifen_anterior: String(feRow.estado_sifen ?? ""),
            estado_sifen_nuevo: rapido.estado,
            dProtAut: rapido.dProtAut,
            mensaje: rapido.mensaje,
          },
        });

        if (aprobado) {
          // Igual que en el camino de lote: si el cliente dejó su correo, se le
          // manda la factura apenas queda aprobada.
          try {
            await enviarFacturaMail({
              supabase,
              empresaId: auth.empresa_id,
              facturaId: fid,
              origen: "automatico",
            });
          } catch (e) {
            console.warn("[sifen-sync] no se pudo mandar la factura por correo", {
              factura_id: fid,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        return NextResponse.json(
          successResponse({
            factura_electronica: toFacturaElectronicaDto(filaSync as Record<string, unknown>),
            via: "sincronico",
            estado_sifen: rapido.estado,
          })
        );
      }

      // No se pudo guardar el veredicto. No se reenvía por lote: el documento ya
      // está en el SET y duplicarlo sería peor. Queda para «Consultar lote».
      console.error("[sifen-sync] veredicto obtenido pero no se pudo guardar", {
        factura_id: fid,
        error: errSync?.message,
      });
      return NextResponse.json(
        errorResponse(
          `El SET resolvió el documento como ${rapido.estado}, pero no se pudo guardar: ${errSync?.message ?? "error"}. Usá «Consultar lote» para sincronizar.`
        ),
        { status: 500 }
      );
    }

    console.log("[sifen-sync] se sigue por lote", { factura_id: fid, motivo: rapido.motivo });
  }

  const msCert = Date.now() - tCert;
  let tSoap = Date.now();
  let resp: RecibeLoteRespuestaParsed;
  try {
    tSoap = Date.now();
    resp = await enviarLoteSifen({
      xmlFirmado: xmlDl.data.toString("utf8"),
      empresaConfig: {
        ambiente: ambienteSoap,
        certificadoP12: p12Dl.data,
        certificadoPassword: p12Password,
      },
      facturaElectronicaId: String(feRow.id),
      envoltorioRloteDe: true,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const label = ambienteSoap === "produccion" ? "SIFEN producción" : "SIFEN TEST";
    // No se llegó a hablar con el SET, así que el documento sigue sin enviar:
    // se suelta el candado para que se pueda reintentar. Dejarlo en "enviado"
    // lo trabaría esperando una respuesta que nunca va a llegar.
    await supabase
      .from("factura_electronica")
      .update({ estado_sifen: "firmado" })
      .eq("id", feRow.id)
      .eq("empresa_id", auth.empresa_id)
      .eq("estado_sifen", "enviado");
    return NextResponse.json(errorResponse(`Fallo al llamar a ${label} (recibe-lote): ${m}`), {
      status: 502,
    });
  }

  const msSoap = Date.now() - tSoap;
  const respuestaJson = respuestaRecibeLoteJson(resp);

  const previousEstado = String(feRow.estado_sifen ?? "firmado");
  const previousError = feRow.error == null ? null : String(feRow.error);
  const previousProt = feRow.sifen_d_prot_cons_lote == null ? null : String(feRow.sifen_d_prot_cons_lote);
  const previousUltima = feRow.sifen_ultima_respuesta_recibe_lote;
  const previousConsultaLote = feRow.sifen_ultima_respuesta_consulta_lote;

  let nuevoEstado: "enviado" | "error_envio";
  let nuevoError: string | null;
  let nuevoProt: string | null;

  const codRecibe = String(resp.dCodRes ?? "").trim();
  const codSinCerosIni = codRecibe.replace(/^0+/, "") || "";
  const codigoEs0300 = codRecibe === "0300" || codSinCerosIni === "300";
  const protTrim = resp.dProtConsLote == null ? "" : String(resp.dProtConsLote).trim();
  const http2xx = resp.httpStatus >= 200 && resp.httpStatus < 300;
  const loteAceptadoPorSet =
    resp.loteRecibido ||
    codigoEs0300 ||
    (http2xx && protTrim.length > 0 && !resp.loteNoEncolado);

  const consultaLoteHint =
    ambienteSoap === "produccion"
      ? " — Use «Consultar lote SET» con el protocolo"
      : " — Use «Consultar lote TEST» con el protocolo";

  if (loteAceptadoPorSet) {
    nuevoEstado = "enviado";
    nuevoError = null;
    nuevoProt = resp.dProtConsLote == null ? null : String(resp.dProtConsLote).trim() || null;
  } else if (resp.loteNoEncolado) {
    nuevoEstado = "error_envio";
    const baseErr =
      [resp.dMsgRes, resp.dCodRes ? `Código ${resp.dCodRes}` : null].filter(Boolean).join(" — ") ||
      "SET no encoló el lote (0301).";
    nuevoProt = protTrim.length > 0 ? protTrim : null;
    let detalleRecibeSync = "";
    try {
      const sync = await recibirDeSifenSync({
        xmlFirmadoRde: xmlDl.data.toString("utf8"),
        empresaConfig: {
          ambiente: ambienteSoap,
          certificadoP12: p12Dl.data,
          certificadoPassword: p12Password,
        },
      });
      if (!sync.soapFault && sync.gResProc.length > 0) {
        const g = sync.gResProc[0]!;
        detalleRecibeSync = ` ${decodificarEntidadesSoapBasicas(`[${g.dCodRes}] ${g.dMsgRes}`)}`;
      }
    } catch {
      /* recibe síncrono es solo ayuda diagnóstico */
    }
    const sufProt =
      nuevoProt != null ? `${consultaLoteHint} ${nuevoProt} para más detalle si aplica.` : "";
    nuevoError = `${baseErr}${detalleRecibeSync ? `.${detalleRecibeSync}` : ""}${sufProt}`;
  } else {
    nuevoEstado = "error_envio";
    const code = resp.dCodRes?.trim() ?? "";
    nuevoError =
      [resp.dMsgRes, code ? `Código ${code}` : null, `HTTP ${resp.httpStatus}`]
        .filter(Boolean)
        .join(" — ") || "Respuesta inesperada de recibe-lote.";
    nuevoProt = protTrim.length > 0 ? protTrim : null;
  }

  const { data: updatedRow, error: errUpdate } = await supabase
    .from("factura_electronica")
    .update({
      estado_sifen: nuevoEstado,
      error: nuevoError,
      sifen_d_prot_cons_lote: nuevoProt,
      sifen_ultima_respuesta_recibe_lote: respuestaJson,
      sifen_ultima_respuesta_consulta_lote: null,
    })
    .eq("id", feRow.id)
    .eq("empresa_id", auth.empresa_id)
    .select()
    .single();

  if (errUpdate || !updatedRow) {
    return NextResponse.json(
      errorResponse(errUpdate?.message ?? "No se pudo actualizar factura_electronica."),
      { status: 500 }
    );
  }

  const detalle: SifenApiEnviarTestDetalle = {
    origen: options.soloAmbienteTest ? "api_enviar_test" : "api_enviar",
    factura_id: fid,
    xml_firmado_path: signedPath,
    dCodRes: resp.dCodRes,
    dMsgRes: resp.dMsgRes,
    dProtConsLote: resp.dProtConsLote,
    httpStatus: resp.httpStatus,
    loteRecibido: resp.loteRecibido,
    loteNoEncolado: resp.loteNoEncolado,
  };

  const { error: errEvento } = await supabase.from("factura_electronica_evento").insert({
    empresa_id: auth.empresa_id,
    factura_electronica_id: feRow.id,
    tipo: "envio",
    detalle,
  });

  if (errEvento) {
    await supabase
      .from("factura_electronica")
      .update({
        estado_sifen: previousEstado,
        error: previousError,
        sifen_d_prot_cons_lote: previousProt,
        sifen_ultima_respuesta_recibe_lote: previousUltima,
        sifen_ultima_respuesta_consulta_lote: previousConsultaLote,
      })
      .eq("id", feRow.id)
      .eq("empresa_id", auth.empresa_id);
    return NextResponse.json(
      errorResponse(`No se pudo registrar el evento; se revirtió el estado: ${errEvento.message}`),
      { status: 500 }
    );
  }

  const dto = toFacturaElectronicaDto(updatedRow as Record<string, unknown>);
  const data: SifenEnviarTestResponseData = {
    factura_electronica: dto,
    storage_bucket: SIFEN_STORAGE_BUCKET,
    recibe_lote: {
      dCodRes: resp.dCodRes,
      dMsgRes: resp.dMsgRes,
      dProtConsLote: resp.dProtConsLote,
      dFecProc: resp.dFecProc,
      dTpoProces: resp.dTpoProces,
      httpStatus: resp.httpStatus,
      loteRecibido: resp.loteRecibido,
      loteNoEncolado: resp.loteNoEncolado,
    },
  };
  if (debugSoap) {
    data.cuerpo_soap = resp.cuerpoSoapCrudo;
    data.solicitud_https = resp.solicitudHttps;
  }

  return NextResponse.json(successResponse(data));
}
