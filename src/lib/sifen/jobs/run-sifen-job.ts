import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { getFacturasServiceClientForEmpresa } from "@/lib/facturacion/facturas-service-client";
import { buildAuthSintetico } from "@/lib/sifen/jobs/auth-sintetico";
import {
  invokeSifenXml,
  invokeSifenFirmar,
  invokeSifenEnviar,
  invokeSifenConsultaLote,
  extraerEstadoSifen,
  type HandlerResult,
} from "@/lib/sifen/jobs/handlers-invoker";
import {
  setSifenJobEtapa,
  setSifenJobEtapaTiempo,
  completeSifenJobAprobado,
  completeSifenJobRechazado,
  registrarIntentoYPlanificar,
} from "@/lib/sifen/jobs/sifen-jobs-repo";
import type {
  SifenJobDTO,
  SifenJobEtapa,
  SifenJobTipoError,
  FacturaElectronicaDTO,
} from "@/lib/sifen/types";

const LABEL = "[sifen-worker]";

/** Config de polling interno de consulta-lote antes de re-encolar. */
/**
 * Cada cuánto se le vuelve a preguntar al SET si ya resolvió el lote.
 *
 * Antes eran 4 intentos con esperas de 1s, 2s, 4s y 8s. El problema no es el
 * total sino el arranque: si el SET ya tenía la respuesta al segundo 2, no nos
 * enterábamos hasta el 3, y si la tenía al 4 no nos enterábamos hasta el 7. Ese
 * hueco es tiempo muerto con el cliente esperando.
 *
 * Ahora se pregunta más seguido al principio, que es cuando la mayoría
 * resuelve, y se va espaciando. La ventana total queda parecida, así que no se
 * golpea más al SET en los casos lentos; sólo se llega antes en los rápidos.
 */
const CONSULTA_DELAYS_MS = [700, 800, 1_000, 1_500, 2_500, 4_000, 5_000]; // ~15.5s
const CONSULTA_INTENTOS_INLINE = CONSULTA_DELAYS_MS.length;
/**
 * Cuántas veces se puede re-encolar el Job por "SET sigue en proceso" antes
 * de rendirse.
 *
 * Antes eran 10 × 30s = ~5 min y se cerraba con tipo_error='set_timeout',
 * dejando el DE clavado en 'enviado' hasta que un humano apretara
 * "Consultar lote". Pero un lote en 0361 ("en procesamiento") NO es un error:
 * SET normalmente tarda mucho más que 5 min. El resultado era que cualquier
 * demora del fisco congelaba la factura, y con ella la venta (que no se puede
 * anular si el DE no está 'aprobado').
 *
 * Ahora el backoff crece (ver BACKOFF_CONSULTA_MS) y cubre ~48h de demora de
 * SET antes de rendirse. El job sigue vivo y resuelve solo.
 *
 * 60 re-encolados = ~48h acumuladas (los primeros 15 suman ~3h; el resto va de
 * a 1h). Verificado numéricamente, no estimado.
 */
const MAX_RE_ENCOLADOS_CONSULTA = 60;

/**
 * Backoff creciente para re-encolar la consulta de lote. Se indexa por
 * `veces_re_encolado_consulta`; a partir del último valor se mantiene el tope.
 * Acumulado ≈ 48h: rápido al principio (la mayoría resuelve en segundos) y
 * espaciado después, para no golpear a SET.
 */
const BACKOFF_CONSULTA_MS = [
  30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 300_000, 300_000, // ~20 min
  600_000, 600_000, 900_000, 900_000, 1_800_000, 1_800_000, // ~1h50 acumulado
  3_600_000, // 1h — de acá en más se mantiene
];

/** Delay del próximo re-encolado según cuántas veces ya se re-encoló. */
function backoffConsultaMs(vecesPrevias: number): number {
  const i = Math.max(0, Math.min(vecesPrevias, BACKOFF_CONSULTA_MS.length - 1));
  return BACKOFF_CONSULTA_MS[i]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Log estructurado pre-envío a SET. Se dispara justo antes de invokeSifenEnviar
 * y sirve para diagnosticar rechazos 0301 [1264] («RUC no habilitado») en
 * producción: deja rastro claro de qué RUC/DV emisor y receptor se está por
 * mandar, si el receptor va como contribuyente (iNatRec=1) o consumidor final
 * (iNatRec=2), en qué ambiente y con qué CDC + sifen_regeneracion_seq (para ver
 * si el retry generó un CDC nuevo). No loguea el certificado ni ninguna
 * contraseña: solo campos "no-secreto" que el operador necesita para investigar
 * un rechazo con el usuario final.
 */
async function logPreEnvioSifen(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaId: string,
  jobLabel: string
): Promise<void> {
  try {
    const { data: fe } = await supabase
      .from("factura_electronica")
      .select("id, cdc, estado_sifen, sifen_regeneracion_seq")
      .eq("factura_id", facturaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const { data: fac } = await supabase
      .from("facturas")
      .select("id, cliente_id")
      .eq("id", facturaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const clienteId = fac?.cliente_id ?? null;
    const { data: cli } = clienteId
      ? await supabase
          .from("clientes")
          .select("id, ruc, documento, es_contribuyente, tipo_cliente")
          .eq("id", clienteId)
          .maybeSingle()
      : { data: null };
    const { data: cfg } = await supabase
      .from("empresa_sifen_config")
      .select("ambiente, ruc")
      .eq("empresa_id", empresaId)
      .maybeSingle();

    const emisorRuc = cfg?.ruc == null ? "" : String(cfg.ruc);
    const emisorDigits = emisorRuc.replace(/\D/g, "");
    const emisorCuerpo = emisorDigits.length > 1 ? emisorDigits.slice(0, -1) : "";
    const emisorDv = emisorDigits.length > 0 ? emisorDigits.slice(-1) : "";

    const recRuc = cli?.ruc == null ? "" : String(cli.ruc);
    const recDigits = recRuc.replace(/\D/g, "");
    const recCuerpo = recDigits.length > 1 ? recDigits.slice(0, -1) : "";
    const recDv = recDigits.length > 0 ? recDigits.slice(-1) : "";
    const esContribuyente =
      cli?.es_contribuyente === true ||
      String(cli?.tipo_cliente ?? "").toLowerCase() === "empresa";
    const iNatRec = esContribuyente && recRuc.trim() ? 1 : 2;
    const iTiOpe = esContribuyente && recRuc.trim() ? 1 : 2;

    console.log(
      `${jobLabel} pre-envio-sifen ${JSON.stringify({
        empresa_id: empresaId,
        factura_id: facturaId,
        cliente_id: clienteId,
        emisor_ruc_cuerpo: emisorCuerpo || null,
        emisor_dv: emisorDv || null,
        receptor_ruc_cuerpo: recCuerpo || null,
        receptor_dv: recDv || null,
        receptor_documento_ci: cli?.documento ?? null,
        receptor_es_contribuyente: esContribuyente,
        receptor_tipo_cliente: cli?.tipo_cliente ?? null,
        i_nat_rec: iNatRec,
        i_ti_ope: iTiOpe,
        cdc: fe?.cdc ?? null,
        estado_sifen: fe?.estado_sifen ?? null,
        sifen_regeneracion_seq: fe?.sifen_regeneracion_seq ?? null,
        ambiente: cfg?.ambiente ?? null,
      })}`
    );
  } catch (e) {
    // Log de diagnóstico: si falla, no debe abortar el envío real.
    console.warn(
      `${jobLabel} pre-envio-sifen log falló (${e instanceof Error ? e.message : String(e)}) — continuando`
    );
  }
}

/** Clasifica un HandlerResult fallido en `tipo_error` según status y mensaje. */
function clasificarError(status: number, mensaje: string): SifenJobTipoError {
  const msg = mensaje.toLowerCase();
  // 502 → recibe-lote/consulta-lote no pudo llegar a SET (red o timeout).
  if (status === 502) return "red";
  // 5xx en general.
  if (status >= 500 && status < 600) {
    if (msg.includes("storage") || msg.includes("bucket") || msg.includes("no se pudo descargar") || msg.includes("no se pudo guardar")) {
      return "storage";
    }
    if (msg.includes("firma") || msg.includes("firmar") || msg.includes(".p12") || msg.includes("xml-dsig")) {
      return "firma";
    }
    return "inesperado";
  }
  // 400/409 → validaciones y configuración.
  if (status === 400 || status === 409) {
    if (
      msg.includes("configuración sifen") ||
      msg.includes("configuracion sifen") ||
      msg.includes("csc") ||
      msg.includes("timbrado") ||
      msg.includes("certificado") ||
      msg.includes("ambiente sifen") ||
      msg.includes("contraseña del certificado")
    ) {
      return "config";
    }
    if (msg.includes(".p12") || msg.includes("firma") || msg.includes("firmar")) {
      return "firma";
    }
    // Reglas fiscales del XML (loadValidatedSifenPayload / buildOfficialRdeFacturaElectronicaXml).
    return "fiscal";
  }
  return "inesperado";
}

/** Clasifica una excepción JS (fuera del handler) por tipo (red / timeout / inesperado). */
function clasificarExcepcion(err: unknown): { tipo: SifenJobTipoError; msg: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lm = msg.toLowerCase();
  if (
    lm.includes("etimedout") ||
    lm.includes("econnreset") ||
    lm.includes("econnrefused") ||
    lm.includes("eai_again") ||
    lm.includes("network") ||
    lm.includes("fetch failed") ||
    lm.includes("timeout")
  ) {
    return { tipo: "red", msg };
  }
  return { tipo: "inesperado", msg };
}

/** Lee el estado_sifen actual — para idempotencia (saltar etapas ya hechas). */
async function leerEstadoActual(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaId: string
): Promise<FacturaElectronicaDTO | null> {
  const { data, error } = await supabase
    .from("factura_electronica")
    .select("*")
    .eq("factura_id", facturaId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error || !data) return null;
  return data as FacturaElectronicaDTO;
}

/**
 * Re-encola el mismo Job con backoff — para consulta-lote cuando SET sigue
 * procesando. NO cuenta como intento fallido (no incrementa `intentos`), pero
 * sí incrementa `veces_re_encolado_consulta` para poder cortarlo eventualmente.
 * Devuelve el nuevo valor del contador.
 */
async function reencolarConsultaEnCurso(
  supabase: AppSupabaseClient,
  job: SifenJobDTO,
  delayMs: number
): Promise<number> {
  const proximo = new Date(Date.now() + delayMs).toISOString();
  const nuevoContador = job.veces_re_encolado_consulta + 1;
  await supabase
    .from("sifen_jobs")
    .update({
      estado: "pendiente",
      etapa: null,
      procesando_desde: null,
      lock_owner: null,
      proximo_reintento_at: proximo,
      veces_re_encolado_consulta: nuevoContador,
    })
    .eq("id", job.id);
  return nuevoContador;
}

/**
 * Cierra el Job en 'error' con tipo_error='set_timeout' cuando SET nunca
 * confirmó el lote tras MAX_RE_ENCOLADOS_CONSULTA. La factura queda en
 * estado 'enviado' (que ya está persistido) y el operador puede darle
 * "Consultar lote" cuando SET responda.
 */
async function cerrarPorSetTimeout(
  supabase: AppSupabaseClient,
  jobId: string,
  vecesReencolado: number,
  tiempoTotalMs: number
): Promise<void> {
  const nowIso = new Date().toISOString();
  const mensaje =
    `SET no confirmó el lote tras ${vecesReencolado} re-intentos automáticos ` +
    `(~${Math.round((vecesReencolado * 30) / 60)} min). La factura sigue registrada como enviada ` +
    `en SET; podés usar "Consultar lote" para verificar el resultado cuando SET responda.`;
  const { error } = await supabase
    .from("sifen_jobs")
    .update({
      estado: "error",
      etapa: "consulta_lote",
      finished_at: nowIso,
      procesando_desde: null,
      lock_owner: null,
      ultimo_error: mensaje,
      tipo_error: "set_timeout",
      tiempo_total_ms: Math.max(0, Math.floor(tiempoTotalMs)),
    })
    .eq("id", jobId);
  if (error) {
    console.error("[sifen-worker] cerrarPorSetTimeout error:", error.message);
  }
}

/**
 * Extrae código SET + subcódigo + mensaje del recibe-lote cuando SET rechaza
 * el lote entero (0301). El mensaje del handler enviar concatena
 * `dMsgRes — Código dCodRes[ detalle]` — parseamos ambos por separado.
 */
function extraerCodigosDelEnviar(
  recibeLote: {
    dCodRes?: string | null;
    dMsgRes?: string | null;
    loteRecibido?: boolean;
    loteNoEncolado?: boolean;
  } | null | undefined,
  feError: string | null | undefined
): { cod: string | null; sub: string | null; msg: string | null } {
  const cod = recibeLote?.dCodRes == null ? null : String(recibeLote.dCodRes).trim() || null;
  const msgSet = recibeLote?.dMsgRes == null ? null : String(recibeLote.dMsgRes).trim() || null;
  // Sub-código: patrón "[1264]" dentro de dMsgRes o del feError.
  const source = `${msgSet ?? ""} ${feError ?? ""}`;
  const subMatch = /\[(\d{2,5})\]/.exec(source);
  const sub = subMatch?.[1] ?? null;
  return { cod, sub, msg: msgSet };
}

interface EtapaMedidaOk<T> {
  ok: true;
  data: T;
  ms: number;
}
interface EtapaMedidaErr {
  ok: false;
  status: number;
  error: string;
  ms: number;
  excepcion?: unknown;
}
type EtapaMedida<T> = EtapaMedidaOk<T> | EtapaMedidaErr;

async function medir<T>(fn: () => Promise<HandlerResult<T>>): Promise<EtapaMedida<T>> {
  const t0 = Date.now();
  try {
    const res = await fn();
    const ms = Date.now() - t0;
    if (res.ok) return { ok: true, data: res.data, ms };
    return { ok: false, status: res.status, error: res.error, ms };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
      excepcion: e,
    };
  }
}

async function fallarIntento(
  supabase: AppSupabaseClient,
  job: SifenJobDTO,
  etapa: SifenJobEtapa,
  tipoError: SifenJobTipoError,
  mensaje: string,
  tiempoMs: number,
  backoffOverrideMs?: number
): Promise<void> {
  const label = `${LABEL}[${job.id}]`;
  const result = await registrarIntentoYPlanificar(supabase, {
    jobActual: job,
    etapa,
    tipoError,
    mensaje,
    tiempoMs,
    backoffOverrideMs,
  });
  console.log(
    `${label} intento ${job.intentos + 1} fallido en etapa=${etapa} tipo=${tipoError} → ${result} (${tiempoMs}ms) msg="${mensaje.slice(0, 300)}"`
  );
}

/**
 * Orquesta el ciclo completo de un Job: xml → firmar → enviar → consulta_lote.
 * Idempotente: lee el estado_sifen antes de cada etapa y salta las ya hechas.
 * Si SET rechaza → cierra el Job como 'rechazado' con el código real.
 * Si falla algo técnico → registra intento; si es reintentable y quedan
 * intentos, re-encola con backoff (5s/20s); si no, cierra como 'error'.
 * Si consulta-lote sigue en proceso → re-encola sin contar como intento.
 */
export async function runSifenJob(job: SifenJobDTO): Promise<void> {
  const label = `${LABEL}[${job.id}]`;
  const totalStart = Date.now();
  const auth = buildAuthSintetico(job.empresa_id);
  let supabase: AppSupabaseClient;
  try {
    supabase = await getFacturasServiceClientForEmpresa(job.empresa_id);
  } catch (e) {
    // Sin cliente Supabase no podemos ni siquiera marcar el error. Log y salir.
    console.error(`${label} no se pudo instanciar service client:`, e);
    return;
  }

  const fid = job.factura_id;
  // Métricas por etapa acumuladas en memoria para el log final.
  const tiempos = { xml: 0, firmar: 0, enviar: 0, consulta: 0 };

  try {
    // === XML ===
    {
      const fe = await leerEstadoActual(supabase, job.empresa_id, fid);
      const st = extraerEstadoSifen(fe);
      // Bloqueadores terminales.
      if (st === "aprobado" || st === "cancelado") {
        console.log(`${label} DE ya en estado terminal ${st} — cerrando Job como aprobado si aplica`);
        if (st === "aprobado") {
          await completeSifenJobAprobado(supabase, job.id, {
            cdc: fe?.cdc ?? null,
            protocoloLote: fe?.sifen_d_prot_cons_lote ?? null,
            respuestaConsultaLote:
              (fe?.sifen_ultima_respuesta_consulta_lote as unknown as Record<string, unknown> | null) ?? null,
            respuestaRecibeLote:
              (fe?.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
            tiempoTotalMs: Date.now() - totalStart,
          });
        }
        return;
      }
      const necesitaXml = !fe || st === "" || st === "borrador" || st === "rechazado";
      if (necesitaXml) {
        await setSifenJobEtapa(supabase, job.id, "xml");
        const r = await medir(() => invokeSifenXml(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "xml", tipo, r.error, r.ms);
          return;
        }
        tiempos.xml = r.ms;
        await setSifenJobEtapaTiempo(supabase, job.id, "xml", r.ms);
        console.log(`${label} etapa=xml ok (${r.ms}ms)`);
      }
    }

    // === FIRMAR ===
    {
      const fe = await leerEstadoActual(supabase, job.empresa_id, fid);
      const st = extraerEstadoSifen(fe);
      const necesitaFirmar =
        st === "generado" ||
        (st === "error_envio" && !!fe?.xml_path && !fe?.xml_firmado_path);
      if (necesitaFirmar) {
        await setSifenJobEtapa(supabase, job.id, "firmar");
        const r = await medir(() => invokeSifenFirmar(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "firmar", tipo, r.error, r.ms);
          return;
        }
        tiempos.firmar = r.ms;
        await setSifenJobEtapaTiempo(supabase, job.id, "firmar", r.ms);
        console.log(`${label} etapa=firmar ok (${r.ms}ms)`);
      }
    }

    // === ENVIAR ===
    {
      const fe = await leerEstadoActual(supabase, job.empresa_id, fid);
      const st = extraerEstadoSifen(fe);
      const necesitaEnviar =
        st === "firmado" || (st === "error_envio" && !!fe?.xml_firmado_path);
      if (necesitaEnviar) {
        await setSifenJobEtapa(supabase, job.id, "enviar");
        await logPreEnvioSifen(supabase, job.empresa_id, fid, label);
        const r = await medir(() => invokeSifenEnviar(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          await fallarIntento(supabase, job, "enviar", tipo, r.error, r.ms);
          return;
        }
        tiempos.enviar = r.ms;
        await setSifenJobEtapaTiempo(supabase, job.id, "enviar", r.ms);
        const recibe = r.data.recibe_lote;
        // Rechazo directo del lote entero (0301 típico): la factura queda en
        // 'error_envio' pero SET ya se pronunció.
        if (recibe && recibe.loteNoEncolado === true) {
          const codigos = extraerCodigosDelEnviar(
            recibe,
            r.data.factura_electronica?.error ?? null
          );

          // Reintento condicional para 0301 [1264]: sabemos por QA en
          // producción que este código a veces es transitorio (SET
          // intermitente / caché de padrón desactualizada). En vez de
          // cerrar como rechazado inmediatamente, se le da UN reintento
          // automático con espera de 30s. Si vuelve a fallar, ahí sí se
          // cierra como rechazado definitivo.
          //
          // Solo se reintenta 0301 [1264] específico (no otros rechazos
          // de negocio como XSD inválido, timbrado vencido, etc., que sí
          // son determinísticos). Solo en el primer intento del job — si
          // ya fue reintentado y volvió a rebotar con lo mismo, cerramos.
          const es0301_1264 = codigos.cod === "0301" && codigos.sub === "1264";
          const primerIntento = job.intentos === 0;
          if (es0301_1264 && primerIntento) {
            console.log(
              `${label} SET rechazó 0301 [1264] en primer intento — regenerando XML y re-encolando con 30s de backoff (a veces transitorio).`
            );
            // Regenerar XML antes del re-encolado. Si no lo hacemos, el
            // segundo intento reenviaría el mismo XML firmado y SET
            // responde CDC duplicado (0362 [1001]) — porque aunque haya
            // rechazado el primer envío con 0301, ya registró el CDC.
            // POST /sifen/xml bumpea sifen_regeneracion_seq → nuevo CDC.
            // El job re-encolado, al ver el estado 'generado', ejecuta
            // el flujo firmar → enviar por su cuenta.
            const rXml = await medir(() => invokeSifenXml(auth, supabase, fid));
            if (!rXml.ok) {
              console.error(
                `${label} regenerar XML falló antes del reintento 0301: ${rXml.error}. Cerramos como rechazado.`
              );
              await completeSifenJobRechazado(supabase, job.id, {
                etapa: "enviar",
                codigoErrorSet: codigos.cod,
                codigoSubErrorSet: codigos.sub,
                mensajeSet:
                  (codigos.msg ?? "SET rechazó el lote (0301).") +
                  ` [Auto-retry abortado: falló la regeneración del XML — ${rXml.error}]`,
                respuestaRecibeLote: recibe as unknown as Record<string, unknown>,
                respuestaConsultaLote: null,
                tiempoTotalMs: Date.now() - totalStart,
              });
              return;
            }
            await fallarIntento(
              supabase,
              job,
              "enviar",
              "http_5xx", // categoría reintentable existente; deja rastro del rechazo en intentos_log
              `SET rechazó 0301 [1264] — reintento automático en 30s con XML regenerado. Mensaje original: ${codigos.msg ?? "(sin mensaje)"}`,
              r.ms,
              30_000 // backoff override: 30s (vs 5s del default)
            );
            return;
          }

          await completeSifenJobRechazado(supabase, job.id, {
            etapa: "enviar",
            codigoErrorSet: codigos.cod,
            codigoSubErrorSet: codigos.sub,
            mensajeSet: codigos.msg ?? r.data.factura_electronica?.error ?? "SET rechazó el lote (0301).",
            respuestaRecibeLote: recibe as unknown as Record<string, unknown>,
            respuestaConsultaLote: null,
            tiempoTotalMs: Date.now() - totalStart,
          });
          console.log(
            `${label} SET rechazó lote codigo=${codigos.cod} sub=${codigos.sub ?? "-"} — cerrando como rechazado`
          );
          return;
        }
        console.log(`${label} etapa=enviar ok (${r.ms}ms) protocolo=${recibe?.dProtConsLote ?? "-"}`);
      }
    }

    // El envío por el canal sincrónico ya trae el veredicto del SET, así que no
    // queda lote que consultar. Sin esto el Job se quedaría preguntando por un
    // protocolo que nunca existió y el trámite tardaría lo mismo que antes.
    {
      const feTrasEnvio = await leerEstadoActual(supabase, job.empresa_id, fid);
      const stTrasEnvio = extraerEstadoSifen(feTrasEnvio);
      if (stTrasEnvio === "aprobado") {
        await completeSifenJobAprobado(supabase, job.id, {
          cdc: feTrasEnvio?.cdc ?? null,
          protocoloLote: feTrasEnvio?.sifen_d_prot_cons_lote ?? null,
          respuestaConsultaLote:
            (feTrasEnvio?.sifen_ultima_respuesta_consulta_lote as unknown as Record<string, unknown> | null) ?? null,
          respuestaRecibeLote:
            (feTrasEnvio?.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
          tiempoTotalMs: Date.now() - totalStart,
        });
        console.log(
          `${label} DE aprobado en el envío sincrónico — total=${Date.now() - totalStart}ms cdc=${feTrasEnvio?.cdc ?? "-"}`
        );
        return;
      }
      if (stTrasEnvio === "rechazado") {
        await completeSifenJobRechazado(supabase, job.id, {
          etapa: "enviar",
          codigoErrorSet: null,
          codigoSubErrorSet: null,
          mensajeSet: feTrasEnvio?.error ?? "SET rechazó el documento.",
          respuestaRecibeLote: null,
          respuestaConsultaLote:
            (feTrasEnvio?.sifen_ultima_respuesta_consulta_lote as unknown as Record<string, unknown> | null) ?? null,
          tiempoTotalMs: Date.now() - totalStart,
        });
        console.log(`${label} DE rechazado en el envío sincrónico — cerrando Job`);
        return;
      }
    }

    // === CONSULTA-LOTE (polling inline) ===
    {
      await setSifenJobEtapa(supabase, job.id, "consulta_lote");
      const consultaStart = Date.now();
      let ultimoResumen: string | null = null;
      let ultimoEstado: string = "";

      for (let i = 0; i < CONSULTA_INTENTOS_INLINE; i++) {
        // Delay antes de cada intento (SET necesita tiempo para procesar).
        await sleep(CONSULTA_DELAYS_MS[i] ?? 5_000);

        const r = await medir(() => invokeSifenConsultaLote(auth, supabase, fid));
        if (!r.ok) {
          const tipo = clasificarError(r.status, r.error);
          // En consulta_lote el DE YA está en SET (tenemos protocolo). Un fallo
          // transitorio de transporte (ECONNRESET, timeout) NO dice nada del
          // documento: solo que no pudimos preguntar. Antes contaba como intento
          // fatal y a los 2 mataba el Job, dejando la factura clavada en
          // 'enviado' para siempre aunque SET la aprobara después. Ahora se
          // re-encola con el mismo backoff que "SET sigue procesando".
          const transitorio = tipo === "red" || tipo === "set_timeout";
          if (transitorio && job.veces_re_encolado_consulta < MAX_RE_ENCOLADOS_CONSULTA) {
            await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
            const delayMs = backoffConsultaMs(job.veces_re_encolado_consulta);
            const nuevoContador = await reencolarConsultaEnCurso(supabase, job, delayMs);
            console.warn(
              `${label} fallo transitorio consultando SET (${tipo}): ${r.error.slice(0, 120)}. Re-encolado +${Math.round(delayMs / 1000)}s (${nuevoContador}/${MAX_RE_ENCOLADOS_CONSULTA}).`
            );
            return;
          }
          await fallarIntento(supabase, job, "consulta_lote", tipo, r.error, Date.now() - consultaStart);
          return;
        }
        const feResp = r.data.factura_electronica;
        ultimoEstado = extraerEstadoSifen(feResp);
        ultimoResumen = r.data.consulta_lote?.resumenInferido ?? null;

        if (ultimoEstado === "aprobado") {
          await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
          await completeSifenJobAprobado(supabase, job.id, {
            cdc: feResp.cdc ?? null,
            protocoloLote: feResp.sifen_d_prot_cons_lote ?? null,
            respuestaConsultaLote:
              (feResp.sifen_ultima_respuesta_consulta_lote as unknown as Record<string, unknown> | null) ?? null,
            respuestaRecibeLote:
              (feResp.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
            tiempoTotalMs: Date.now() - totalStart,
          });
          tiempos.consulta = Date.now() - consultaStart;
          console.log(
            `${label} DE aprobado por SET — total=${Date.now() - totalStart}ms xml=${tiempos.xml}ms firmar=${tiempos.firmar}ms enviar=${tiempos.enviar}ms consulta=${tiempos.consulta}ms cdc=${feResp.cdc ?? "-"}`
          );
          return;
        }
        if (ultimoEstado === "rechazado") {
          await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
          const uc = feResp.sifen_ultima_respuesta_consulta_lote as
            | { dCodResLot?: string | null; dMsgResLot?: string | null; detallePorCdc?: unknown[] }
            | null
            | undefined;
          // Sub-código: buscar en detallePorCdc[0].grupoRes[0].dCodRes.
          const detalle = Array.isArray(uc?.detallePorCdc) ? (uc?.detallePorCdc as Array<{ grupoRes?: Array<{ dCodRes?: string; dMsgRes?: string }> }>) : [];
          const grupo0 = detalle[0]?.grupoRes?.[0];
          await completeSifenJobRechazado(supabase, job.id, {
            etapa: "consulta_lote",
            codigoErrorSet: uc?.dCodResLot ?? null,
            codigoSubErrorSet: grupo0?.dCodRes ?? null,
            mensajeSet: grupo0?.dMsgRes ?? uc?.dMsgResLot ?? feResp.error ?? "SET rechazó el DE.",
            respuestaConsultaLote: uc as unknown as Record<string, unknown>,
            respuestaRecibeLote:
              (feResp.sifen_ultima_respuesta_recibe_lote as unknown as Record<string, unknown> | null) ?? null,
            tiempoTotalMs: Date.now() - totalStart,
          });
          console.log(
            `${label} DE rechazado por SET codigo=${uc?.dCodResLot ?? "-"} sub=${grupo0?.dCodRes ?? "-"} — cerrando como rechazado`
          );
          return;
        }
        // Sigue en enviado/en_proceso. Reintento inline.
      }

      // Se agotaron los intentos inline. Decidimos entre re-encolar o cerrar
      // por set_timeout según el contador de re-encolados previos.
      await setSifenJobEtapaTiempo(supabase, job.id, "consulta_lote", Date.now() - consultaStart);
      if (job.veces_re_encolado_consulta >= MAX_RE_ENCOLADOS_CONSULTA) {
        await cerrarPorSetTimeout(
          supabase,
          job.id,
          job.veces_re_encolado_consulta,
          Date.now() - totalStart
        );
        console.warn(
          `${label} SET sigue en proceso tras ${job.veces_re_encolado_consulta} re-encolados — cerrando como set_timeout (DE queda en 'enviado' con protocolo; el operador puede consultar-lote manual).`
        );
        return;
      }
      const delayMs = backoffConsultaMs(job.veces_re_encolado_consulta);
      const nuevoContador = await reencolarConsultaEnCurso(supabase, job, delayMs);
      console.log(
        `${label} SET sigue en proceso (${ultimoEstado}, resumen="${ultimoResumen ?? "-"}"). Re-encolado +${Math.round(delayMs / 1000)}s (${nuevoContador}/${MAX_RE_ENCOLADOS_CONSULTA}).`
      );
      return;
    }
  } catch (e) {
    // Cualquier excepción no capturada en las etapas.
    const { tipo, msg } = clasificarExcepcion(e);
    const etapaActual = (job.etapa ?? "xml") as SifenJobEtapa;
    console.error(`${label} excepción no capturada en etapa=${etapaActual}:`, msg);
    try {
      await fallarIntento(supabase, job, etapaActual, tipo, msg, Date.now() - totalStart);
    } catch (e2) {
      console.error(`${label} tampoco pudo registrar el fallo:`, e2);
    }
  }
}
