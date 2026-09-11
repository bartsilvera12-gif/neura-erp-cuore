/**
 * Manda la factura al correo del cliente.
 *
 * Se adjuntan dos archivos y cada uno tiene su motivo:
 *   · el KUDE en PDF A4, que es lo que la persona abre y lee;
 *   · el XML firmado, que es el documento con valor legal y el que su contador
 *     necesita para descargarlo en su propia contabilidad.
 *
 * El KUDE se manda en A4 y no en el formato ticket configurado para el local:
 * el ticket de 80 mm está pensado para la impresora térmica del mostrador y por
 * correo se lee mal. En papel se imprime el ticket, por mail va el A4.
 *
 * Sólo se manda con el documento aprobado por la SET. Antes de eso el KUDE no
 * existe como comprobante válido, y mandar un archivo que después cambia es
 * peor que no mandar nada.
 *
 * Nunca lanza excepción: quien llama puede ser el flujo de aprobación del DE, y
 * que el correo falle no puede tumbar una factura ya aprobada.
 */
import { downloadSifenObject } from "@/lib/sifen/sifen-storage";
import { buildKudePdfBuffer, type KudeBranding } from "@/lib/sifen/kude-pdf";
import {
  kudeFallbackQrUrl,
  parseKudeFromSignedRdeXml,
} from "@/lib/sifen/parse-kude-from-signed-xml";
import { enviarMail, mailConfigurado } from "@/lib/mail/enviar-mail";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

export type EnviarFacturaMailCodigo =
  | "enviado"
  | "no_configurado"
  | "sin_destinatario"
  | "no_aprobada"
  | "sin_xml"
  | "error";

export interface EnviarFacturaMailInput {
  supabase: AppSupabaseClient;
  empresaId: string;
  facturaId: string;
  /** 'automatico' al aprobar el DE; 'manual' desde el botón Reenviar. */
  origen: "automatico" | "manual";
  /** Mandar a otra dirección sin tocar la ficha del cliente. */
  destinatarioOverride?: string | null;
  enviadoPor?: string | null;
}

export interface EnviarFacturaMailResult {
  ok: boolean;
  codigo: EnviarFacturaMailCodigo;
  message: string;
  destinatario: string | null;
}

const RE_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function limpio(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Nº de protocolo de autorización, dentro de la respuesta de consulta-lote. */
function dProtAutDesdeConsulta(cdc: string, consulta: unknown): string | null {
  if (!consulta || typeof consulta !== "object") return null;
  const o = consulta as Record<string, unknown>;
  const raw = o.detallePorCdc ?? o.detalle_por_cdc;
  if (!Array.isArray(raw)) return null;
  const hit = (raw as { cdc?: string; dProtAut?: string | null }[]).find((d) => d.cdc === cdc);
  const v = limpio(hit?.dProtAut);
  return v === "" ? null : v;
}

async function cargarBranding(
  supabase: AppSupabaseClient,
  empresaId: string
): Promise<KudeBranding | null> {
  try {
    const { data } = await supabase
      .from("empresa_sifen_config")
      .select("kude_logo_path, kude_color_primario, kude_color_primario_fill")
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (!data) return null;
    const row = data as {
      kude_logo_path: string | null;
      kude_color_primario: string | null;
      kude_color_primario_fill: string | null;
    };
    const colorPrimario = limpio(row.kude_color_primario) || null;
    const colorPrimarioFill = limpio(row.kude_color_primario_fill) || null;

    let logoBytes: Uint8Array | null = null;
    const logoPath = limpio(row.kude_logo_path);
    if (logoPath) {
      const dl = await downloadSifenObject(supabase, logoPath);
      if (dl.ok) logoBytes = new Uint8Array(dl.data);
    }
    if (!logoBytes && !colorPrimario && !colorPrimarioFill) return null;
    return { logoBytes, colorPrimario, colorPrimarioFill };
  } catch {
    // El branding es apariencia: si falla, el PDF sale con el diseño por
    // defecto. No es motivo para no mandarle la factura al cliente.
    return null;
  }
}

function cuerpoHtml(opts: {
  razonSocial: string;
  nombreEmisor: string;
  numeroFactura: string;
  cdc: string;
  telEmisor: string;
  mailEmisor: string;
}): string {
  const saludo = opts.razonSocial ? `Hola, ${opts.razonSocial}:` : "Hola:";
  const contacto = [opts.telEmisor, opts.mailEmisor].filter((v) => v !== "").join(" · ");
  const firma = contacto
    ? `${opts.nombreEmisor}<br><span style="font-size:12px;color:#6b7280">${contacto}</span>`
    : opts.nombreEmisor;
  return [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.6">`,
    `  <p>${saludo}</p>`,
    `  <p>Te adjuntamos tu factura electrónica <strong>${opts.numeroFactura}</strong>.</p>`,
    `  <p style="font-size:12px;color:#4b5563">`,
    `    Van dos archivos: el <strong>KUDE en PDF</strong>, que es la representación`,
    `    impresa de la factura, y el <strong>XML firmado</strong>, que es el documento`,
    `    electrónico en sí — es el que necesita tu contador.`,
    `  </p>`,
    `  <p style="font-size:12px;color:#6b7280">CDC: ${opts.cdc}</p>`,
    `  <p style="margin-top:24px">${firma}</p>`,
    `</div>`,
  ].join("\n");
}

function cuerpoTexto(opts: {
  razonSocial: string;
  nombreEmisor: string;
  numeroFactura: string;
  cdc: string;
}): string {
  const saludo = opts.razonSocial ? `Hola, ${opts.razonSocial}:` : "Hola:";
  return [
    saludo,
    "",
    `Te adjuntamos tu factura electrónica ${opts.numeroFactura}.`,
    "",
    "Van dos archivos: el KUDE en PDF, que es la representación impresa de la",
    "factura, y el XML firmado, que es el documento electrónico en sí.",
    "",
    `CDC: ${opts.cdc}`,
    "",
    opts.nombreEmisor,
  ].join("\n");
}

export async function enviarFacturaMail(
  input: EnviarFacturaMailInput
): Promise<EnviarFacturaMailResult> {
  const { supabase, empresaId, facturaId } = input;

  const registrar = async (
    destinatario: string,
    ok: boolean,
    messageId: string | null,
    error: string | null
  ) => {
    try {
      await supabase.from("factura_email_envios").insert({
        empresa_id: empresaId,
        factura_id: facturaId,
        destinatario,
        origen: input.origen,
        ok,
        message_id: messageId,
        error,
        enviado_por: input.enviadoPor ?? null,
      });
    } catch (e) {
      console.warn("[factura-mail] no se pudo registrar el envio", {
        factura_id: facturaId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  try {
    if (!mailConfigurado()) {
      return {
        ok: false,
        codigo: "no_configurado",
        message: "El envío por correo no está configurado.",
        destinatario: null,
      };
    }

    const { data: facRow } = await supabase
      .from("facturas")
      .select("id, numero_factura, cliente_email, cliente_razon_social, cliente_id")
      .eq("id", facturaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (!facRow) {
      return { ok: false, codigo: "error", message: "Factura no encontrada.", destinatario: null };
    }
    const fac = facRow as {
      numero_factura: string | null;
      cliente_email: string | null;
      cliente_razon_social: string | null;
      cliente_id: string | null;
    };

    // Orden: lo que se pidió a mano, después la copia que guardó la factura, y
    // recién al final la ficha del cliente (que pudo cambiar después de emitir).
    let destinatario = limpio(input.destinatarioOverride) || limpio(fac.cliente_email);
    if (!destinatario && fac.cliente_id) {
      const { data: cliRow } = await supabase
        .from("clientes")
        .select("email")
        .eq("id", fac.cliente_id)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      destinatario = limpio((cliRow as { email?: string | null } | null)?.email);
    }
    if (!destinatario) {
      return {
        ok: false,
        codigo: "sin_destinatario",
        message: "La factura no tiene un correo al que mandarla.",
        destinatario: null,
      };
    }
    if (!RE_MAIL.test(destinatario)) {
      await registrar(destinatario, false, null, "Dirección de correo inválida.");
      return {
        ok: false,
        codigo: "sin_destinatario",
        message: `"${destinatario}" no es una dirección de correo válida.`,
        destinatario,
      };
    }

    const { data: feRow } = await supabase
      .from("factura_electronica")
      .select("estado_sifen, xml_firmado_path, cdc, sifen_ultima_respuesta_consulta_lote")
      .eq("factura_id", facturaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (!feRow) {
      return {
        ok: false,
        codigo: "no_aprobada",
        message: "Esta factura no tiene documento electrónico.",
        destinatario,
      };
    }
    const fe = feRow as {
      estado_sifen: string | null;
      xml_firmado_path: string | null;
      cdc: string | null;
      sifen_ultima_respuesta_consulta_lote: unknown;
    };
    if (limpio(fe.estado_sifen) !== "aprobado") {
      return {
        ok: false,
        codigo: "no_aprobada",
        message: "La factura se manda por correo recién cuando la SET la aprueba.",
        destinatario,
      };
    }

    const xmlPath = limpio(fe.xml_firmado_path);
    if (!xmlPath) {
      return {
        ok: false,
        codigo: "sin_xml",
        message: "No hay XML firmado para adjuntar.",
        destinatario,
      };
    }
    const dl = await downloadSifenObject(supabase, xmlPath);
    if (!dl.ok) {
      await registrar(destinatario, false, null, `No se pudo leer el XML firmado: ${dl.message}`);
      return {
        ok: false,
        codigo: "sin_xml",
        message: `No se pudo leer el XML firmado: ${dl.message}`,
        destinatario,
      };
    }
    const xmlBuffer = dl.data;
    const parsed = parseKudeFromSignedRdeXml(xmlBuffer.toString("utf8"));

    // Igual que en el KUDE impreso: el teléfono y el correo del emisor salen de
    // la configuración y no del XML, porque los documentos viejos pueden llevar
    // datos de contacto que ya no son los del local.
    let telOverride = "";
    let mailOverride = "";
    try {
      const { data: cfgRow } = await supabase
        .from("empresa_sifen_config")
        .select("emisor_telefono, emisor_email")
        .eq("empresa_id", empresaId)
        .maybeSingle();
      const row = cfgRow as { emisor_telefono?: string | null; emisor_email?: string | null } | null;
      telOverride = limpio(row?.emisor_telefono);
      mailOverride = limpio(row?.emisor_email);
    } catch {
      /* se usa lo que trae el XML */
    }

    const branding = await cargarBranding(supabase, empresaId);
    const numeroFactura = limpio(fac.numero_factura);

    const pdf = await buildKudePdfBuffer({
      parsed,
      numeroFactura,
      dProtAut: dProtAutDesdeConsulta(parsed.cdc, fe.sifen_ultima_respuesta_consulta_lote),
      qrUrl: parsed.dCarQR ?? kudeFallbackQrUrl(parsed.cdc),
      branding,
      emisorTelefonoOverride: telOverride || null,
      emisorEmailOverride: mailOverride || null,
    });

    const nombreEmisor = limpio(parsed.emisor.dNomEmi) || "Neura ERP";
    const razonSocial = limpio(fac.cliente_razon_social) || limpio(parsed.receptor.nombre);
    const base = `factura-${(numeroFactura || parsed.cdc.slice(-8)).replace(/[^\w.-]+/g, "_")}`;

    const envio = await enviarMail({
      para: destinatario,
      asunto: `Factura electrónica ${numeroFactura} - ${nombreEmisor}`,
      html: cuerpoHtml({
        razonSocial,
        nombreEmisor,
        numeroFactura,
        cdc: parsed.cdc,
        telEmisor: telOverride || limpio(parsed.emisor.dTelEmi),
        mailEmisor: mailOverride || limpio(parsed.emisor.dEmailE),
      }),
      texto: cuerpoTexto({ razonSocial, nombreEmisor, numeroFactura, cdc: parsed.cdc }),
      adjuntos: [
        { filename: `${base}.pdf`, content: pdf, contentType: "application/pdf" },
        { filename: `${base}.xml`, content: xmlBuffer, contentType: "application/xml" },
      ],
    });

    await registrar(
      destinatario,
      envio.ok,
      envio.messageId ?? null,
      envio.ok ? null : envio.message
    );

    return {
      ok: envio.ok,
      codigo: envio.ok ? "enviado" : "error",
      message: envio.ok ? `Factura enviada a ${destinatario}.` : envio.message,
      destinatario,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[factura-mail] excepcion", { factura_id: facturaId, msg });
    return { ok: false, codigo: "error", message: `No se pudo enviar: ${msg}`, destinatario: null };
  }
}
