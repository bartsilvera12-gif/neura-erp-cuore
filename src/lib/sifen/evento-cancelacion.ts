/**
 * Evento de CANCELACIÓN SIFEN (`siRecepEvento`).
 *
 * Por qué existe
 * --------------
 * Hasta ahora "cancelar" un documento electrónico solo marcaba
 * `estado_sifen='cancelado'` en la base: NO se le avisaba a la SET, así que el
 * documento seguía aprobado y vigente en el libro de ventas. Este módulo manda
 * el evento real.
 *
 * Sirve tanto para facturas como para notas de crédito: la SET cancela por CDC,
 * no le importa el tipo de documento.
 *
 * Estructura (rEve / rGeVeCan)
 * ----------------------------
 * El nodo firmado es `rEve` (referenciado por su `Id`), y la `Signature` va como
 * hermana posterior dentro de `rGesEve` — mismo perfil de firma que el DE
 * (RSA-SHA256, digest SHA-256, enveloped + C14N exclusivo).
 *
 * Plazo: la SET solo acepta la cancelación dentro de una ventana desde la
 * aprobación (normalmente 48 h). Fuera de plazo responde con rechazo.
 */
import { SignedXml } from "xml-crypto";
import { createPrivateKey } from "node:crypto";
import https from "node:https";
import { URL } from "node:url";
import { SIFEN_EKUATIA_TARGET_NS } from "./sifen-xsi-schema-location";
import { escapeXml } from "./xml";
import type { P12KeyMaterial } from "./sign-xml";
import { extractKeyAndCertFromP12 } from "./sign-xml";
import { urlEventos } from "./sifen-ws-urls";
import type { AmbienteSifen } from "./types";

const SIFEN_NS = SIFEN_EKUATIA_TARGET_NS;
const SOAP_ENV = "http://www.w3.org/2003/05/soap-envelope";
const XMLNS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
/** SET rechaza con 0160 ("XML mal formado") si falta este schemaLocation. */
const EVENTO_SCHEMA_LOCATION = `${SIFEN_NS} siRecepEvento_v150.xsd`;

/** Mismo perfil de firma que el DE (ver sign-xml.ts). */
const XPATH_REVE = "//*[local-name(.)='rEve']";
const TRANSFORMS = [
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  "http://www.w3.org/2001/10/xml-exc-c14n#",
] as const;
const DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";
const SIG_ALG = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

/** `mOtEve` (motivo del evento): la SET exige entre 5 y 500 caracteres. */
export function normalizarMotivoEvento(motivo: string): string {
  const m = String(motivo ?? "").trim().replace(/\s+/g, " ");
  if (m.length < 5) {
    throw new Error("El motivo de cancelación debe tener al menos 5 caracteres.");
  }
  return m.slice(0, 500);
}

/** `dFecFirma`: fecha-hora local sin zona, formato SIFEN (YYYY-MM-DDTHH:mm:ss). */
function fechaFirmaSifen(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export type BuildEventoCancelacionOptions = {
  /** CDC (44 dígitos) del documento a cancelar: factura o nota de crédito. */
  cdc: string;
  /** Motivo (mOtEve), 5–500 caracteres. */
  motivo: string;
  /** Id del evento dentro del lote. Numérico, único por envío. */
  idEvento?: number;
  /** Solo para tests deterministas. */
  fechaFirma?: Date;
};

/**
 * `rEnviEventoDe` SIN firmar, con la MISMA estructura que la librería de
 * referencia (facturacionelectronicapy-xmlgen): el default namespace va en
 * `rEnviEventoDe` (heredado hacia abajo, NO se redeclara en rGesEve) y
 * `gGroupGesEve` lleva `xsi:schemaLocation` — sin eso la SET responde 0160
 * "XML mal formado". El `rEve` lleva `Id` porque es lo que referencia la firma.
 */
export function buildEventoCancelacionXml(opts: BuildEventoCancelacionOptions): string {
  const cdc = String(opts.cdc ?? "").replace(/\D/g, "");
  if (cdc.length !== 44) {
    throw new Error(`CDC inválido para el evento de cancelación (se esperaban 44 dígitos, hay ${cdc.length}).`);
  }
  const motivo = normalizarMotivoEvento(opts.motivo);
  const idEvento = Number.isFinite(Number(opts.idEvento)) && Number(opts.idEvento) > 0
    ? Math.floor(Number(opts.idEvento))
    : 1;
  const dFecFirma = fechaFirmaSifen(opts.fechaFirma ?? new Date());

  return (
    `<rEnviEventoDe xmlns="${SIFEN_NS}">` +
    `<dId>${idEvento}</dId>` +
    `<dEvReg>` +
    `<gGroupGesEve xmlns:xsi="${XMLNS_XSI}" xsi:schemaLocation="${escapeXml(EVENTO_SCHEMA_LOCATION)}">` +
    `<rGesEve>` +
    `<rEve Id="${idEvento}">` +
    `<dFecFirma>${dFecFirma}</dFecFirma>` +
    `<dVerFor>150</dVerFor>` +
    `<gGroupTiEvt>` +
    `<rGeVeCan>` +
    `<Id>${escapeXml(cdc)}</Id>` +
    `<mOtEve>${escapeXml(motivo)}</mOtEve>` +
    `</rGeVeCan>` +
    `</gGroupTiEvt>` +
    `</rEve>` +
    `</rGesEve>` +
    `</gGroupGesEve>` +
    `</dEvReg>` +
    `</rEnviEventoDe>`
  );
}

/**
 * Firma el `rEve` dentro del `rEnviEventoDe`: la `Signature` queda como hermana
 * posterior de `rEve`, dentro de `rGesEve` (mismo criterio que la firma del `DE`
 * bajo `rDE`). Se firma con el contexto de namespaces final para que el digest
 * coincida cuando SET recanonicaliza el `rEve`.
 */
export function signEventoCancelacionXml(xmlUtf8: string, material: P12KeyMaterial): string {
  const trimmed = xmlUtf8.trim();
  if (!/<\s*rEve\b/i.test(trimmed) || !/<\s*rEnviEventoDe\b/i.test(trimmed)) {
    throw new Error("Se esperaba un XML con raíz rEnviEventoDe que contenga un rEve para firmar.");
  }

  const privateKey = createPrivateKey({ key: material.privateKeyPem, format: "pem" });

  const sig = new SignedXml({
    privateKey,
    publicCert: material.certificatePem,
    signatureAlgorithm: SIG_ALG,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });

  sig.addReference({
    xpath: XPATH_REVE,
    transforms: [...TRANSFORMS],
    digestAlgorithm: DIGEST,
  });

  sig.computeSignature(trimmed, {
    location: { reference: XPATH_REVE, action: "after" },
  });

  return sig.getSignedXml();
}

function stripXmlDeclaration(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/i, "");
}

/** Envelope SOAP 1.2. El `rEnviEventoDe` firmado ya trae dId/dEvReg/gGroupGesEve. */
function construirSoapEvento(rEnviEventoDeFirmado: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<env:Envelope xmlns:env="${SOAP_ENV}">` +
    `<env:Header/>` +
    `<env:Body>` +
    stripXmlDeclaration(rEnviEventoDeFirmado) +
    `</env:Body>` +
    `</env:Envelope>`
  );
}

function extraerTexto(xml: string, local: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${local}\\s*>`, "i");
  const m = re.exec(xml);
  return m ? m[1]!.trim() : null;
}

export type EventoCancelacionRespuesta = {
  httpStatus: number;
  /** Código de resultado del evento (`dCodRes`). "0600" = evento registrado. */
  dCodRes: string | null;
  dMsgRes: string | null;
  dFecProc: string | null;
  /** true si el documento queda cancelado en la SET (registrado ahora o ya lo estaba). */
  cancelado: boolean;
  /** true cuando la SET responde que el CDC YA tenía el evento (4003): no se registró
   *  nada nuevo, pero el documento está cancelado igual. */
  yaEstabaCancelado: boolean;
  soapFault: boolean;
  cuerpoSoapCrudo: string;
  /** SOAP enviado a la SET (diagnóstico ante rechazos como "XML mal formado"). */
  requestSoap: string;
};

/** La SET responde 0600 cuando el evento de cancelación queda registrado. */
const COD_EVENTO_REGISTRADO = "0600";
/**
 * 4003 = "CDC ya se encuentra con el mismo evento solicitado": el documento YA está
 * cancelado en la SET (típico al reintentar / doble clic). Es un resultado de ÉXITO
 * idempotente, no un rechazo: tratarlo como error confundía al operador ("parece que
 * no se canceló") cuando en Marangatú ya figuraba anulado.
 */
const COD_EVENTO_YA_REGISTRADO = "4003";

function parsearRespuestaEvento(
  httpStatus: number,
  xml: string,
  requestSoap: string
): EventoCancelacionRespuesta {
  const soapFault = /<(?:\w+:)?Fault\b/i.test(xml);
  const dCodRes = extraerTexto(xml, "dCodRes");
  const dMsgRes = extraerTexto(xml, "dMsgRes");
  const dFecProc = extraerTexto(xml, "dFecProc");
  const yaEstabaCancelado = !soapFault && dCodRes === COD_EVENTO_YA_REGISTRADO;
  return {
    httpStatus,
    dCodRes,
    dMsgRes,
    dFecProc,
    cancelado: !soapFault && (dCodRes === COD_EVENTO_REGISTRADO || yaEstabaCancelado),
    yaEstabaCancelado,
    soapFault,
    cuerpoSoapCrudo: xml,
    requestSoap,
  };
}

function postHttpsMtls(
  urlStr: string,
  body: string,
  certPem: string,
  keyPem: string
): Promise<{ status: number; body: string }> {
  const url = new URL(urlStr);
  const port = url.port ? Number(url.port) : 443;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        cert: certPem,
        key: keyPem,
        rejectUnauthorized: true,
        headers: {
          "Content-Type": "application/soap+xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(body, "utf8"),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (ch) => chunks.push(ch as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    req.write(body, "utf8");
    req.end();
  });
}

export type EnviarEventoCancelacionParams = {
  ambiente: AmbienteSifen;
  cdc: string;
  motivo: string;
  certificadoP12: Buffer;
  certificadoPassword: string;
  /** dId del envío. Por defecto 1. */
  dId?: number;
  fechaFirma?: Date;
};

/**
 * Construye, firma y envía a la SET el evento de cancelación del CDC indicado.
 * Devuelve la respuesta parseada; `cancelado` es true SOLO si la SET la registró.
 */
export async function enviarEventoCancelacionSifen(
  params: EnviarEventoCancelacionParams
): Promise<EventoCancelacionRespuesta> {
  const material = extractKeyAndCertFromP12(params.certificadoP12, params.certificadoPassword);

  const dId = Number.isFinite(Number(params.dId)) && Number(params.dId) > 0
    ? Math.floor(Number(params.dId))
    : 1;

  const xml = buildEventoCancelacionXml({
    cdc: params.cdc,
    motivo: params.motivo,
    idEvento: dId,
    fechaFirma: params.fechaFirma,
  });
  const firmado = signEventoCancelacionXml(xml, material);
  const soap = construirSoapEvento(firmado);

  const res = await postHttpsMtls(
    urlEventos(params.ambiente),
    soap,
    material.certificatePem,
    material.privateKeyPem
  );

  return parsearRespuestaEvento(res.status, res.body, soap);
}
