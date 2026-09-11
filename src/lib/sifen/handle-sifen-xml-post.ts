import { NextRequest, NextResponse } from "next/server";
import type { UsuarioConEmpresa } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { loadValidatedSifenPayload } from "@/lib/sifen/load-factura-payload";
import { buildOfficialRdeFacturaElectronicaXml } from "@/lib/sifen/rde-xml";
import {
  buildSifenXmlObjectPath,
  ensureSifenStorageBucket,
  removeSifenObject,
  SIFEN_STORAGE_BUCKET,
  uploadSifenXml,
} from "@/lib/sifen/sifen-storage";
import type {
  FacturaElectronicaDTO,
  SifenApiXmlGeneracionDetalle,
  SifenXmlGeneracionResponseData,
} from "@/lib/sifen/types";

/**
 * Solo `aprobado` y `cancelado` bloquean regeneración. `enviado` permite
 * corregir y volver a firmar si el lote falla (p. ej. 1858) sin depender de
 * que la consulta-lote haya actualizado ya el estado en BD.
 */
const ESTADOS_BLOQUEADOS_XML = new Set<string>(["aprobado", "cancelado"]);

/**
 * Genera XML rDE oficial (SIFEN v150, factura electrónica), lo sube a Storage
 * y actualiza `factura_electronica`. No firma ni envía a SET.
 *
 * Extraído del route `POST /api/facturas/[id]/sifen/xml`. Preservado bit-a-bit;
 * ningún cambio de comportamiento HTTP ni de reglas fiscales. El route pasa a
 * ser un wrapper thin que resuelve `auth + supabase` y delega aquí.
 *
 * En Fase 3 (worker) se agregará una función `ejecutarSifenXml` pura por debajo.
 */
export async function handleSifenXmlPost(
  request: NextRequest,
  params: Promise<{ id: string }>,
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient
): Promise<NextResponse> {
  const { id: facturaId } = await params;
  if (!facturaId?.trim()) {
    return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });
  }

  const debugXml = request.nextUrl.searchParams.get("debug") === "1";
  const fid = facturaId.trim();

  const { data: feSnapshot, error: errSnap } = await supabase
    .from("factura_electronica")
    .select(
      "id, xml_path, xml_firmado_path, estado_sifen, sifen_regeneracion_seq, error, cdc, sifen_d_prot_cons_lote, sifen_ultima_respuesta_consulta_lote, sifen_ultima_respuesta_recibe_lote"
    )
    .eq("factura_id", fid)
    .eq("empresa_id", auth.empresa_id)
    .maybeSingle();

  if (errSnap) {
    return NextResponse.json(errorResponse(errSnap.message), { status: 400 });
  }
  if (!feSnapshot) {
    return NextResponse.json(
      errorResponse(
        "No existe registro electrónico para esta factura. Cree primero el borrador con POST /api/facturas/{id}/sifen/borrador."
      ),
      { status: 400 }
    );
  }

  if (ESTADOS_BLOQUEADOS_XML.has(String(feSnapshot.estado_sifen))) {
    return NextResponse.json(
      errorResponse(
        `No se puede regenerar el XML: el documento está en estado "${feSnapshot.estado_sifen}".`
      ),
      { status: 409 }
    );
  }

  const previousEstado = String(feSnapshot.estado_sifen ?? "borrador");
  const rawPrev = feSnapshot.sifen_regeneracion_seq;
  const previousRegSeq = Number.isFinite(Number(rawPrev)) ? Math.max(0, Math.floor(Number(rawPrev))) : 0;
  let bumpAplicado = false;

  // Bumpear el contador de regeneración también en `error_envio`: es el mismo
  // caso funcional que `rechazado` (el DE anterior ya interactuó con SET, aunque
  // en `error_envio` la falla fue en el envío, no en la validación del DE).
  // Si no bumpeamos, el nuevo XML mantiene el mismo código de seguridad → mismo
  // CDC → SET rebota 0362 [1001] "CDC duplicado".
  const debeBumpear = previousEstado === "rechazado" || previousEstado === "error_envio";
  if (debeBumpear) {
    const nextSeq = previousRegSeq + 1;
    const { data: bumped, error: bumpErr } = await supabase
      .from("factura_electronica")
      .update({ sifen_regeneracion_seq: nextSeq })
      .eq("id", feSnapshot.id)
      .eq("empresa_id", auth.empresa_id)
      .eq("estado_sifen", previousEstado)
      .eq("sifen_regeneracion_seq", previousRegSeq)
      .select("sifen_regeneracion_seq")
      .maybeSingle();

    if (bumpErr) {
      return NextResponse.json(errorResponse(bumpErr.message), { status: 500 });
    }
    if (!bumped) {
      return NextResponse.json(
        errorResponse(
          "No se pudo reservar una nueva revisión del documento (el estado pudo cambiar). Actualizá la página e intentá de nuevo."
        ),
        { status: 409 }
      );
    }
    bumpAplicado = true;
  }

  const revertBumpRegSeq = async () => {
    if (!bumpAplicado) return;
    bumpAplicado = false;
    await supabase
      .from("factura_electronica")
      .update({ sifen_regeneracion_seq: previousRegSeq })
      .eq("id", feSnapshot.id)
      .eq("empresa_id", auth.empresa_id);
  };

  const loaded = await loadValidatedSifenPayload(supabase, auth.empresa_id, fid);
  if (!loaded.ok) {
    await revertBumpRegSeq();
    return NextResponse.json(errorResponse(loaded.error.message), {
      status: loaded.error.status,
    });
  }

  if (loaded.payload.sifen.factura_electronica_id !== feSnapshot.id) {
    await revertBumpRegSeq();
    return NextResponse.json(errorResponse("Inconsistencia entre factura electrónica y payload."), {
      status: 500,
    });
  }

  const fecha = loaded.payload.documento.fecha.trim();
  const yAnio = /^(\d{4})/.exec(fecha)?.[1] ?? String(new Date().getFullYear());
  let xmlString: string;
  try {
    xmlString = buildOfficialRdeFacturaElectronicaXml(loaded.payload, {
      timbradoFechaInicio: loaded.payload.emisor.timbrado_fecha_inicio_vigencia,
      timbradoFechaFin: `${yAnio}-12-31`,
      ambiente: loaded.ambiente,
      // Fallback histórico solo si no hay dato en empresa_sifen_config.
      // Cuando el usuario carga su número/email desde Configuración →
      // Facturación electrónica, esos valores aparecen en dTelEmi/dEmailE del
      // XML y en el encabezado del KUDE. Antes iban hardcodeados con valores
      // que no eran del emisor y aparecían en la factura del cliente.
      emisorTelefono: loaded.payload.emisor.telefono ?? "021000000",
      emisorEmail: loaded.payload.emisor.email ?? "facturacion@configurar-empresa.com.py",
      emisorDireccion: loaded.payload.emisor.direccion_fiscal.trim(),
      emisorNumCasa: 0,
      actividadEconomicaCodigo: loaded.payload.emisor.actividad_economica_codigo,
      actividadEconomicaDescripcion: loaded.payload.emisor.actividad_economica_descripcion,
    });
  } catch (e) {
    await revertBumpRegSeq();
    const msg = e instanceof Error ? e.message : "Error al generar XML SIFEN";
    return NextResponse.json(errorResponse(msg), { status: 400 });
  }

  const cdcMatch = /\bId="(\d{44})"/.exec(xmlString);
  const cdc = cdcMatch?.[1] ?? null;
  const objectPath = buildSifenXmlObjectPath(auth.empresa_id, fid);

  const bucketOk = await ensureSifenStorageBucket(supabase);
  if (!bucketOk.ok) {
    await revertBumpRegSeq();
    return NextResponse.json(errorResponse(`Storage SIFEN: ${bucketOk.message}`), { status: 500 });
  }

  const up = await uploadSifenXml(supabase, objectPath, xmlString);
  if (!up.ok) {
    await revertBumpRegSeq();
    return NextResponse.json(
      errorResponse(`No se pudo guardar el XML en storage: ${up.message}`),
      { status: 500 }
    );
  }

  const previousXmlPath =
    feSnapshot.xml_path === null || feSnapshot.xml_path === undefined
      ? null
      : String(feSnapshot.xml_path);
  const previousSignedPath =
    feSnapshot.xml_firmado_path === null || feSnapshot.xml_firmado_path === undefined
      ? null
      : String(feSnapshot.xml_firmado_path).trim() || null;

  const { data: updatedRow, error: errUpdate } = await supabase
    .from("factura_electronica")
    .update({
      xml_path: objectPath,
      estado_sifen: "generado",
      xml_firmado_path: null,
      ...(cdc ? { cdc } : {}),
      ...(debeBumpear
        ? {
            error: null,
            sifen_d_prot_cons_lote: null,
            sifen_ultima_respuesta_consulta_lote: null,
            sifen_ultima_respuesta_recibe_lote: null,
          }
        : {}),
    })
    .eq("id", feSnapshot.id)
    .eq("empresa_id", auth.empresa_id)
    .select()
    .single();

  if (errUpdate || !updatedRow) {
    await removeSifenObject(supabase, objectPath);
    await revertBumpRegSeq();
    return NextResponse.json(
      errorResponse(
        errUpdate?.message ??
          "No se pudo actualizar factura_electronica; el archivo subido fue eliminado."
      ),
      { status: 500 }
    );
  }

  bumpAplicado = false;

  const detalle: SifenApiXmlGeneracionDetalle = {
    origen: "api_xml",
    factura_id: fid,
    xml_path: objectPath,
    ...(debeBumpear ? { sifen_regeneracion_seq: previousRegSeq + 1 } : {}),
  };

  const { error: errEvento } = await supabase.from("factura_electronica_evento").insert({
    empresa_id: auth.empresa_id,
    factura_electronica_id: feSnapshot.id,
    tipo: "generacion",
    detalle,
  });

  if (errEvento) {
    await supabase
      .from("factura_electronica")
      .update({
        xml_path: previousXmlPath,
        estado_sifen: previousEstado,
        xml_firmado_path: previousSignedPath,
        ...(debeBumpear
          ? {
              sifen_regeneracion_seq: previousRegSeq,
              error: feSnapshot.error ?? null,
              cdc: feSnapshot.cdc ?? null,
              sifen_d_prot_cons_lote: feSnapshot.sifen_d_prot_cons_lote ?? null,
              sifen_ultima_respuesta_consulta_lote: feSnapshot.sifen_ultima_respuesta_consulta_lote ?? null,
              sifen_ultima_respuesta_recibe_lote: feSnapshot.sifen_ultima_respuesta_recibe_lote ?? null,
            }
          : {}),
      })
      .eq("id", feSnapshot.id)
      .eq("empresa_id", auth.empresa_id);
    await removeSifenObject(supabase, objectPath);
    return NextResponse.json(
      errorResponse(`No se pudo registrar el evento; se revirtió el estado y el archivo: ${errEvento.message}`),
      { status: 500 }
    );
  }

  if (previousSignedPath) {
    await removeSifenObject(supabase, previousSignedPath);
  }

  const data: SifenXmlGeneracionResponseData = {
    factura_electronica: updatedRow as FacturaElectronicaDTO,
    xml_path: objectPath,
    storage_bucket: SIFEN_STORAGE_BUCKET,
  };
  if (debugXml) {
    data.xml = xmlString;
  }

  return NextResponse.json(successResponse(data));
}
