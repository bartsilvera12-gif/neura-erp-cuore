import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { requireAdminEmpresa } from "@/lib/auth/require-admin-empresa";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { extractOrigenFiscalDesdeRdeXml } from "@/lib/sifen/parse-kude-from-signed-xml";
import {
  buildSifenSignedXmlObjectPath,
  ensureSifenStorageBucket,
  uploadSifenXml,
} from "@/lib/sifen/sifen-storage";

/**
 * POST /api/facturas/[id]/sifen/reimportar-firmado  (ADMIN)
 *
 * Recupera una factura cuyo documento electrónico quedó DESINCRONIZADO con la
 * SET: el ERP guardó el CDC/XML de un reenvío RECHAZADO, pero en Marangatú la
 * factura está APROBADA con otro CDC. Esto pasa cuando el sistema regenera y
 * reenvía un documento ya aprobado: cada regeneración cambia el código de
 * seguridad del CDC y sobrescribe el XML firmado, perdiendo el aprobado. Sin ese
 * XML, la Nota de Crédito no puede armarse (apunta a un CDC inexistente).
 *
 * El admin sube el XML firmado descargado de Marangatú. Se valida que sea la
 * MISMA factura (RUC del emisor + tipo/establecimiento/punto/número/fecha del
 * CDC — solo cambia el código de seguridad), se repone como XML firmado vigente
 * y se corrige el CDC. NO re-firma ni reenvía: solo repone el documento que ya
 * existe aprobado en la SET. Deja la factura en estado_sifen='aprobado'.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminEmpresa(request);
    if (!admin.ok) return admin.response;

    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { auth, supabase } = ctx;

    const { id } = await params;
    const fid = id?.trim();
    if (!fid) return NextResponse.json(errorResponse("id de factura es obligatorio"), { status: 400 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(errorResponse("Cuerpo JSON inválido"), { status: 400 });
    }
    const xml =
      typeof (body as { xml?: unknown })?.xml === "string" ? String((body as { xml: string }).xml).trim() : "";
    if (!xml || !/<(?:\w+:)?rDE\b/.test(xml)) {
      return NextResponse.json(errorResponse("Falta el XML firmado (rDE) o no tiene formato válido."), {
        status: 400,
      });
    }
    if (xml.length > 2_000_000) {
      return NextResponse.json(errorResponse("El XML es demasiado grande."), { status: 400 });
    }

    const { data: factura } = await supabase
      .from("facturas")
      .select("id, numero_factura")
      .eq("id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    if (!factura) return NextResponse.json(errorResponse("Factura no encontrada"), { status: 404 });

    const { data: feRow } = await supabase
      .from("factura_electronica")
      .select("id, cdc, estado_sifen")
      .eq("factura_id", fid)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    if (!feRow) return NextResponse.json(errorResponse("La factura no tiene documento electrónico."), { status: 409 });

    // ── Parsear y validar el XML aprobado ──────────────────────────────────
    let orig: ReturnType<typeof extractOrigenFiscalDesdeRdeXml>;
    try {
      orig = extractOrigenFiscalDesdeRdeXml(xml);
    } catch (e) {
      return NextResponse.json(
        errorResponse(`No se pudo leer el XML: ${e instanceof Error ? e.message : "inválido"}`),
        { status: 400 }
      );
    }

    const cdcNuevo = String(orig.cdcId ?? "").replace(/\D/g, "");
    if (cdcNuevo.length !== 44) {
      return NextResponse.json(errorResponse("El XML no tiene un CDC (Id) de 44 dígitos."), { status: 400 });
    }
    if (orig.iTiDE.replace(/\D/g, "").replace(/^0+/, "") !== "1") {
      return NextResponse.json(errorResponse("El XML no es una factura electrónica (iTiDE distinto de 1)."), {
        status: 400,
      });
    }

    // RUC del emisor debe ser el de la empresa. La config guarda el RUC con
    // dígito verificador ("80131562-0"); el XML trae el RUC base (dRucEm, sin
    // DV) y el DV aparte (dDVEmi). Comparamos solo el RUC base para no rechazar
    // por el DV.
    const { data: cfg } = await supabase
      .from("empresa_sifen_config")
      .select("ruc")
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    const rucBase = (v: unknown) => String(v ?? "").split("-")[0].replace(/\D/g, "");
    const rucCfg = rucBase((cfg as { ruc?: string } | null)?.ruc);
    const rucXml = rucBase(orig.emisor.dRucEm);
    if (rucCfg && rucXml && rucCfg !== rucXml) {
      return NextResponse.json(
        errorResponse(`El XML es de otro RUC emisor (${rucXml}); no corresponde a esta empresa.`),
        { status: 400 }
      );
    }

    // Debe ser la MISMA factura: el CDC nuevo comparte los primeros 34 dígitos
    // con el que ya tiene el ERP (tipo + RUC + est + punto + nroDoc + fecha);
    // solo difiere el código de seguridad (aleatorio por envío).
    const cdcErp = String((feRow as { cdc?: string | null }).cdc ?? "").replace(/\D/g, "");
    if (cdcErp.length === 44) {
      if (cdcErp.slice(0, 34) !== cdcNuevo.slice(0, 34)) {
        return NextResponse.json(
          errorResponse(
            "El XML no corresponde a esta factura (número/establecimiento/fecha del CDC no coinciden). " +
              "Verificá que descargaste el comprobante correcto de Marangatú."
          ),
          { status: 400 }
        );
      }
    } else {
      // Sin CDC previo válido: al menos el número de documento del CDC debe coincidir.
      const nroErp = String(factura.numero_factura ?? "").replace(/\D/g, "").slice(-7).padStart(7, "0");
      const nroXml = cdcNuevo.slice(17, 24);
      if (nroErp && nroErp !== nroXml) {
        return NextResponse.json(errorResponse(`El XML es de la factura N° ${nroXml}, no de ${nroErp}.`), {
          status: 400,
        });
      }
    }

    // ── Reponer el XML firmado aprobado + corregir el CDC ──────────────────
    const bucketOk = await ensureSifenStorageBucket(supabase);
    if (!bucketOk.ok) return NextResponse.json(errorResponse(`Storage SIFEN: ${bucketOk.message}`), { status: 500 });
    const objectPath = buildSifenSignedXmlObjectPath(auth.empresa_id, fid);
    const up = await uploadSifenXml(supabase, objectPath, xml);
    if (!up.ok) return NextResponse.json(errorResponse(`No se pudo guardar el XML: ${up.message}`), { status: 500 });

    const cdcAnterior = cdcErp || null;
    const { data: updated, error: errUp } = await supabase
      .from("factura_electronica")
      .update({
        cdc: cdcNuevo,
        xml_firmado_path: objectPath,
        estado_sifen: "aprobado",
        error: null,
      })
      .eq("id", (feRow as { id: string }).id)
      .eq("empresa_id", auth.empresa_id)
      .select()
      .single();
    if (errUp || !updated) {
      return NextResponse.json(
        errorResponse(errUp?.message ?? "No se pudo actualizar la factura electrónica."),
        { status: 500 }
      );
    }

    await supabase.from("factura_electronica_evento").insert({
      empresa_id: auth.empresa_id,
      factura_electronica_id: (feRow as { id: string }).id,
      tipo: "firma",
      detalle: {
        origen: "api_reimportar_firmado",
        subtipo: "reimportacion_documento_aprobado",
        factura_id: fid,
        cdc_anterior: cdcAnterior,
        cdc_nuevo: cdcNuevo,
        actor: admin.auth.user?.email ?? null,
      },
    });

    return NextResponse.json(
      successResponse({ cdc: cdcNuevo, estado_sifen: "aprobado", numero_factura: factura.numero_factura })
    );
  } catch (err) {
    return NextResponse.json(errorResponse(err instanceof Error ? err.message : "Error"), { status: 500 });
  }
}
