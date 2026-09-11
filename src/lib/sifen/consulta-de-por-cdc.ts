/**
 * Consulta de DE por CDC (`siConsDE`) — endpoint `consultas/consulta.wsdl`.
 *
 * Por qué existe
 * --------------
 * El sistema solo sabía preguntar por LOTE (`consulta-lote`). Cuando SET deja un
 * lote colgado en `0361` ("en procesamiento"), esa vía nunca resuelve y el DE
 * queda clavado en `enviado` — y con él la venta, que no se puede anular si el
 * DE no está `aprobado`.
 *
 * Esta consulta pregunta por el DOCUMENTO (CDC), no por el lote. Si SET ya lo
 * procesó, responde su estado real aunque el lote siga trabado.
 *
 * Estructura tomada de la librería de referencia `facturacionelectronicapy-setapi`
 * (probada contra SET), incluido el Content-Type: SET responde a
 * `application/xml` en este endpoint, no a `application/soap+xml`.
 */
import https from "node:https";
import { URL } from "node:url";
import { SIFEN_EKUATIA_TARGET_NS } from "./sifen-xsi-schema-location";
import { extractKeyAndCertFromP12 } from "./sign-xml";
import { urlConsultaDe } from "./sifen-ws-urls";
import type { AmbienteSifen } from "./types";

const SIFEN_NS = SIFEN_EKUATIA_TARGET_NS;
const SOAP_ENV = "http://www.w3.org/2003/05/soap-envelope";

function construirSoapConsultaDe(dId: number, cdc: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<env:Envelope xmlns:env="${SOAP_ENV}">` +
    `<env:Header/>` +
    `<env:Body>` +
    `<rEnviConsDeRequest xmlns="${SIFEN_NS}">` +
    `<dId>${dId}</dId>` +
    `<dCDC>${cdc}</dCDC>` +
    `</rEnviConsDeRequest>` +
    `</env:Body>` +
    `</env:Envelope>`
  );
}

function extraerTexto(xml: string, local: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${local}\\s*>`, "i");
  const m = re.exec(xml);
  return m ? m[1]!.trim() : null;
}

export type ConsultaDeRespuesta = {
  httpStatus: number;
  soapFault: boolean;
  /** `dCodRes` de la consulta. 0422 = CDC encontrado; 0420 = no existe. */
  dCodRes: string | null;
  dMsgRes: string | null;
  dFecProc: string | null;
  /** Estado del DE según SET (`dEstRes` dentro de gResProc), p. ej. "Aprobado". */
  dEstRes: string | null;
  /** Protocolo de autorización, si SET ya lo aprobó. */
  dProtAut: string | null;
  /** true solo si SET reporta el DE como aprobado/autorizado. */
  aprobado: boolean;
  /** true si SET reporta el DE explícitamente como rechazado/cancelado. */
  rechazado: boolean;
  /** true si SET no conoce el CDC (todavía no procesado o inexistente). */
  noEncontrado: boolean;
  cuerpoSoapCrudo: string;
  requestSoap: string;
};

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
          // La referencia usa application/xml en este endpoint (no soap+xml).
          "Content-Type": "application/xml; charset=utf-8",
          "User-Agent": "neura-erp",
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

export type ConsultarDePorCdcParams = {
  ambiente: AmbienteSifen;
  cdc: string;
  certificadoP12: Buffer;
  certificadoPassword: string;
  dId?: number;
};

/**
 * Pregunta a SET por el estado REAL de un DE usando su CDC, sin depender del lote.
 */
export async function consultarDePorCdc(params: ConsultarDePorCdcParams): Promise<ConsultaDeRespuesta> {
  const cdc = String(params.cdc ?? "").replace(/\D/g, "");
  if (cdc.length !== 44) {
    throw new Error(`CDC inválido para consulta (se esperaban 44 dígitos, hay ${cdc.length}).`);
  }
  const material = extractKeyAndCertFromP12(params.certificadoP12, params.certificadoPassword);
  const dId =
    Number.isFinite(Number(params.dId)) && Number(params.dId) > 0 ? Math.floor(Number(params.dId)) : 1;

  const soap = construirSoapConsultaDe(dId, cdc);
  const res = await postHttpsMtls(
    urlConsultaDe(params.ambiente),
    soap,
    material.certificatePem,
    material.privateKeyPem
  );

  const xml = res.body;
  const soapFault = /<(?:\w+:)?Fault\b/i.test(xml);
  const dCodRes = extraerTexto(xml, "dCodRes");
  const dMsgRes = extraerTexto(xml, "dMsgRes");
  const dFecProc = extraerTexto(xml, "dFecProc");
  const dEstRes = extraerTexto(xml, "dEstRes");
  const dProtAut = extraerTexto(xml, "dProtAut");

  const est = (dEstRes ?? "").toLowerCase();
  const aprobado = !soapFault && /aprob|acept|autoriz|confirm/.test(est);
  const rechazado = !soapFault && /rechaz|cancel|inutiliz/.test(est);
  // 0420 = "CDC no encontrado" en el catálogo SET.
  const noEncontrado = !soapFault && !dEstRes && String(dCodRes ?? "").trim() === "0420";

  return {
    httpStatus: res.status,
    soapFault,
    dCodRes,
    dMsgRes,
    dFecProc,
    dEstRes,
    dProtAut,
    aprobado,
    rechazado,
    noEncontrado,
    cuerpoSoapCrudo: xml,
    requestSoap: soap,
  };
}
