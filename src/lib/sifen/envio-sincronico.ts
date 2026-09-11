/**
 * Envío sincrónico de un documento al SET.
 *
 * El SET expone dos servicios para recibir documentos:
 *
 *   · `recibe-lote` (asincrónico): se manda el documento, contesta con un
 *     número de protocolo y después hay que preguntar si lo aprobaron. De ahí
 *     sale la escalera de consultas (1s, 2s, 4s, 8s) que se lleva la mayor
 *     parte de los ~20 segundos que tardaba una factura.
 *
 *   · `recibe` (sincrónico, siRecepDE): contesta aprobado o rechazado en la
 *     misma llamada. Sin protocolo y sin escalera.
 *
 * Acá se usa el sincrónico y el de lote queda como respaldo.
 *
 * ── Lo delicado: no mandar el mismo documento dos veces ──────────────────────
 *
 * Si la llamada sincrónica falla de forma ambigua —se cortó la red, el SET
 * contestó algo que no sabemos leer— NO se puede reintentar por lote sin más.
 * El documento pudo haber quedado registrado igual, y mandarlo de nuevo con el
 * mismo CDC hace que el SET lo rechace por duplicado: terminaríamos marcando
 * como fallido un documento que en realidad está aprobado.
 *
 * Por eso ante una respuesta ambigua no se adivina: se le pregunta al SET por
 * el CDC (siConsDE) qué pasó realmente. Recién si contesta que no lo conoce se
 * manda por lote.
 */
import { recibirDeSifenSync } from "@/lib/sifen/recibe-de-sifen-test";
import { consultarDePorCdc } from "@/lib/sifen/consulta-de-por-cdc";
import type { AmbienteSifen, SifenConsultaLoteUltimaPersistida } from "@/lib/sifen/types";

export type ResultadoEnvioSincronico =
  /** El SET dio veredicto. No hace falta consultar nada más. */
  | {
      tipo: "resuelto";
      estado: "aprobado" | "rechazado";
      dProtAut: string | null;
      mensaje: string | null;
      /** Para persistir en el mismo formato que usa la consulta de lote. */
      persistible: SifenConsultaLoteUltimaPersistida;
    }
  /** No se pudo resolver por esta vía; hay que mandarlo por lote. */
  | { tipo: "usar_lote"; motivo: string };

export interface EnvioSincronicoParams {
  xmlFirmadoRde: string;
  cdc: string;
  ambiente: AmbienteSifen;
  certificadoP12: Buffer;
  certificadoPassword: string;
}

/**
 * Rechazos del SET que en la práctica no son definitivos.
 *
 * El 1264 («RUC del emisor no está habilitado para este tipo de servicio») va y
 * viene: el 1 de septiembre, con el mismo emisor y el mismo receptor, el SET
 * rechazó a las 13:03, aprobó a las 13:17 y a las 13:19, y volvió a rechazar a
 * las 13:30. No es un problema de los datos.
 *
 * El camino de lote ya sabía esto y lo reintenta. Acá no se puede dar por
 * cerrado: se devuelve al lote, que tiene esa maquinaria de reintento.
 */
const RECHAZOS_INTERMITENTES = new Set(["1264"]);

function esRechazoIntermitente(gResProc: { dCodRes: string; dMsgRes: string }[]): boolean {
  return gResProc.some((g) => {
    if (RECHAZOS_INTERMITENTES.has(String(g.dCodRes).trim())) return true;
    // El código también aparece entre corchetes dentro del mensaje.
    return [...RECHAZOS_INTERMITENTES].some((c) => g.dMsgRes.includes(`[${c}]`));
  });
}

/** Deja el texto del SET legible: viene con entidades XML tipo `&#225;`. */
function legible(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(String(n), 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Mismo criterio que se usa al leer la respuesta de la consulta de lote. */
function veredictoDe(dEstRes: string | null): "aprobado" | "rechazado" | null {
  const est = String(dEstRes ?? "").toLowerCase();
  if (est === "") return null;
  if (/rechaz/.test(est)) return "rechazado";
  if (/aprob|acept|autoriz|confirm/.test(est)) return "aprobado";
  return null;
}

/**
 * Arma la respuesta en el formato que ya guarda la consulta de lote, para que
 * el KUDE y la pantalla encuentren el número de autorización donde siempre.
 */
function persistir(args: {
  cdc: string;
  dEstRes: string | null;
  dProtAut: string | null;
  dFecProc: string | null;
  httpStatus: number;
  gResProc: { dCodRes: string; dMsgRes: string }[];
}): SifenConsultaLoteUltimaPersistida {
  return {
    consultadoEn: new Date().toISOString(),
    // El canal sincrónico no entrega protocolo de lote: no hay lote.
    dProtConsLote: "",
    dFecProc: args.dFecProc,
    dCodResLot: args.gResProc[0]?.dCodRes ?? null,
    dMsgResLot: args.gResProc[0]?.dMsgRes ?? null,
    httpStatus: args.httpStatus,
    soapFault: false,
    faultString: null,
    loteSinDetalleCdc: false,
    detallePorCdc: [
      {
        cdc: args.cdc,
        dEstRes: args.dEstRes ?? "",
        dProtAut: args.dProtAut,
        grupoRes: args.gResProc.map((g) => ({ dCodRes: g.dCodRes, dMsgRes: g.dMsgRes })),
      },
    ],
  };
}

/**
 * Le pregunta al SET por el CDC qué pasó con el documento.
 *
 * Se llama cuando la respuesta sincrónica quedó ambigua. Es la diferencia entre
 * saber y suponer: sin esto, reintentar por lote puede duplicar el documento.
 */
async function averiguarPorCdc(
  p: EnvioSincronicoParams
): Promise<ResultadoEnvioSincronico> {
  try {
    const r = await consultarDePorCdc({
      ambiente: p.ambiente,
      cdc: p.cdc,
      certificadoP12: p.certificadoP12,
      certificadoPassword: p.certificadoPassword,
    });

    if (r.noEncontrado) {
      // El SET no lo tiene: el envío no llegó a registrarse. Se puede mandar
      // por lote sin riesgo de duplicarlo.
      return { tipo: "usar_lote", motivo: "el envío sincrónico no llegó a registrarse" };
    }
    const veredicto = r.aprobado ? "aprobado" : r.rechazado ? "rechazado" : null;
    if (veredicto) {
      return {
        tipo: "resuelto",
        estado: veredicto,
        dProtAut: r.dProtAut ?? null,
        mensaje: r.dMsgRes ? legible(r.dMsgRes) : null,
        persistible: persistir({
          cdc: p.cdc,
          dEstRes: r.dEstRes ?? veredicto,
          dProtAut: r.dProtAut ?? null,
          dFecProc: null,
          httpStatus: r.httpStatus,
          gResProc: r.dCodRes ? [{ dCodRes: r.dCodRes, dMsgRes: r.dMsgRes ?? "" }] : [],
        }),
      };
    }
    // El SET lo conoce pero todavía no opina. Mandarlo de nuevo lo duplicaría.
    return {
      tipo: "usar_lote",
      motivo: "el SET conoce el documento pero aún no dio veredicto",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { tipo: "usar_lote", motivo: `no se pudo confirmar por CDC: ${msg}` };
  }
}

export async function enviarDeSincronico(
  p: EnvioSincronicoParams
): Promise<ResultadoEnvioSincronico> {
  let sync;
  try {
    sync = await recibirDeSifenSync({
      xmlFirmadoRde: p.xmlFirmadoRde,
      empresaConfig: {
        ambiente: p.ambiente,
        certificadoP12: p.certificadoP12,
        certificadoPassword: p.certificadoPassword,
      },
    });
  } catch (e) {
    // Se cortó antes de saber si el SET lo recibió: hay que averiguarlo.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[sifen-sync] la llamada falló, se consulta por CDC", { cdc: p.cdc, msg });
    return averiguarPorCdc(p);
  }

  if (sync.soapFault) {
    console.warn("[sifen-sync] fault SOAP, se consulta por CDC", {
      cdc: p.cdc,
      fault: sync.faultString,
    });
    return averiguarPorCdc(p);
  }

  const veredicto = veredictoDe(sync.dEstRes);
  if (!veredicto) {
    // Contestó algo que no sabemos interpretar. Igual que arriba: preguntar.
    console.warn("[sifen-sync] respuesta sin veredicto claro, se consulta por CDC", {
      cdc: p.cdc,
      dEstRes: sync.dEstRes,
    });
    return averiguarPorCdc(p);
  }

  // Un rechazo que el SET suele revertir al reintentar no se da por cerrado:
  // se devuelve al camino de lote, que ya sabe reintentarlo. Un documento
  // rechazado no queda registrado en el SET, así que reenviarlo no lo duplica.
  if (veredicto === "rechazado" && esRechazoIntermitente(sync.gResProc)) {
    return {
      tipo: "usar_lote",
      motivo: "el SET rechazó con un código que suele resolverse al reintentar",
    };
  }

  const mensaje = sync.gResProc[0]
    ? legible(`[${sync.gResProc[0].dCodRes}] ${sync.gResProc[0].dMsgRes}`)
    : null;

  return {
    tipo: "resuelto",
    estado: veredicto,
    dProtAut: sync.dProtAut,
    mensaje,
    persistible: persistir({
      cdc: p.cdc,
      dEstRes: sync.dEstRes,
      dProtAut: sync.dProtAut,
      dFecProc: sync.dFecProc,
      httpStatus: sync.httpStatus,
      gResProc: sync.gResProc,
    }),
  };
}
