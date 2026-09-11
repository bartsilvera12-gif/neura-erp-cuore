import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { NEURA_CLIENT_SCHEMA } from "@/lib/supabase/schema";
import type {
  SifenJobDTO,
  SifenJobEstado,
  SifenJobEtapa,
  SifenJobIntento,
  SifenJobTipoError,
} from "@/lib/sifen/types";

/**
 * Repositorio de la cola SIFEN — sólo lecturas y creación.
 *
 * El worker (Fase 3) agregará `claimNextJob`, `completeJob`, `failJob`,
 * `reclaimStuckJobs`, `retryJobAsync`. Fase 2 sólo necesita:
 *   - `enqueueSifenJob`: llamado por /sifen/encolar y /sifen/reintentar.
 *   - `getLastJobForFe`: consumido por /sifen/resumen para renderizar el panel.
 *
 * El Job congela `data_schema` al momento del encolado para que el worker
 * pueda operar sin re-resolver la empresa desde JWT/cookie — que fue la
 * causa exacta del bug del pipeline-async anterior.
 */

export interface EnqueueSifenJobArgs {
  empresaId: string;
  facturaId: string;
  facturaElectronicaId: string;
  origen: "auto_venta" | "reintento_manual" | "manual_admin";
  /** Override opcional del schema del tenant; por defecto NEURA_CLIENT_SCHEMA. */
  dataSchema?: string;
}

export type EnqueueSifenJobResult =
  | { ok: true; job: SifenJobDTO; ya_habia_activo: false }
  /**
   * Ya existía un job pendiente/procesando para el mismo DE (unique parcial).
   * No es un error: el operador aprieta doble "Reintentar" o refresca la
   * página y el server responde 200 con el job existente.
   */
  | { ok: true; job: SifenJobDTO; ya_habia_activo: true }
  | { ok: false; message: string; status: number };

interface RawJobRow {
  id: string;
  empresa_id: string;
  data_schema: string;
  factura_id: string;
  factura_electronica_id: string;
  estado: string;
  etapa: string | null;
  intentos: number | string;
  max_intentos_auto: number | string;
  intentos_log: unknown;
  codigo_error_set: string | null;
  codigo_sub_error_set: string | null;
  mensaje_set: string | null;
  ultimo_error: string | null;
  tipo_error: string | null;
  respuesta_recibe_lote: unknown;
  respuesta_consulta_lote: unknown;
  cdc: string | null;
  protocolo_lote: string | null;
  tiempo_xml_ms: number | string | null;
  tiempo_firmar_ms: number | string | null;
  tiempo_enviar_ms: number | string | null;
  tiempo_consulta_ms: number | string | null;
  tiempo_total_ms: number | string | null;
  origen: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  procesando_desde: string | null;
  lock_owner: string | null;
  proximo_reintento_at: string | null;
  veces_re_encolado_consulta: number | string | null;
}

function toDto(row: RawJobRow): SifenJobDTO {
  const toInt = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };
  const toIntOrNull = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    data_schema: row.data_schema,
    factura_id: row.factura_id,
    factura_electronica_id: row.factura_electronica_id,
    estado: row.estado as SifenJobEstado,
    etapa: (row.etapa ?? null) as SifenJobEtapa | null,
    intentos: toInt(row.intentos),
    max_intentos_auto: toInt(row.max_intentos_auto),
    intentos_log: Array.isArray(row.intentos_log) ? row.intentos_log : [],
    codigo_error_set: row.codigo_error_set,
    codigo_sub_error_set: row.codigo_sub_error_set,
    mensaje_set: row.mensaje_set,
    ultimo_error: row.ultimo_error,
    tipo_error: row.tipo_error as SifenJobDTO["tipo_error"],
    respuesta_recibe_lote: (row.respuesta_recibe_lote as Record<string, unknown> | null) ?? null,
    respuesta_consulta_lote: (row.respuesta_consulta_lote as Record<string, unknown> | null) ?? null,
    cdc: row.cdc,
    protocolo_lote: row.protocolo_lote,
    tiempo_xml_ms: toIntOrNull(row.tiempo_xml_ms),
    tiempo_firmar_ms: toIntOrNull(row.tiempo_firmar_ms),
    tiempo_enviar_ms: toIntOrNull(row.tiempo_enviar_ms),
    tiempo_consulta_ms: toIntOrNull(row.tiempo_consulta_ms),
    tiempo_total_ms: toIntOrNull(row.tiempo_total_ms),
    origen: row.origen as SifenJobDTO["origen"],
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    procesando_desde: row.procesando_desde,
    lock_owner: row.lock_owner,
    proximo_reintento_at: row.proximo_reintento_at,
    veces_re_encolado_consulta: toInt(row.veces_re_encolado_consulta),
  };
}

/**
 * Inserta un nuevo Job en la cola. Si ya existe uno vivo (pendiente/procesando)
 * para el mismo DE devuelve `{ ya_habia_activo: true, job }` — cubre el caso
 * de doble clic en "Reintentar" o refresh del panel que redispara auto=1.
 */
export async function enqueueSifenJob(
  supabase: AppSupabaseClient,
  args: EnqueueSifenJobArgs
): Promise<EnqueueSifenJobResult> {
  const dataSchema = (args.dataSchema ?? NEURA_CLIENT_SCHEMA).trim();
  const insertRes = await supabase
    .from("sifen_jobs")
    .insert({
      empresa_id: args.empresaId,
      data_schema: dataSchema,
      factura_id: args.facturaId,
      factura_electronica_id: args.facturaElectronicaId,
      estado: "pendiente",
      origen: args.origen,
    })
    .select("*")
    .single();

  if (insertRes.error) {
    if (insertRes.error.code === "23505") {
      const { data: activo, error: errActivo } = await supabase
        .from("sifen_jobs")
        .select("*")
        .eq("empresa_id", args.empresaId)
        .eq("factura_electronica_id", args.facturaElectronicaId)
        .in("estado", ["pendiente", "procesando"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (errActivo) {
        return { ok: false, message: errActivo.message, status: 500 };
      }
      if (!activo) {
        return {
          ok: false,
          message: "El DE ya tenía un job activo pero no se pudo leer.",
          status: 500,
        };
      }
      return { ok: true, job: toDto(activo as RawJobRow), ya_habia_activo: true };
    }
    return { ok: false, message: insertRes.error.message, status: 500 };
  }

  return {
    ok: true,
    job: toDto(insertRes.data as RawJobRow),
    ya_habia_activo: false,
  };
}

/**
 * Último Job por factura_electronica (para /sifen/resumen). Puede ser null si
 * la emisión ocurrió por el flujo sincrónico manual sin encolar.
 */
export async function getLastSifenJobForFe(
  supabase: AppSupabaseClient,
  empresaId: string,
  facturaElectronicaId: string
): Promise<SifenJobDTO | null> {
  const { data, error } = await supabase
    .from("sifen_jobs")
    .select("*")
    .eq("empresa_id", empresaId)
    .eq("factura_electronica_id", facturaElectronicaId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toDto(data as RawJobRow);
}

// =============================================================================
// Worker (Fase 3) — claim / complete / fail / reclaim
// =============================================================================

/**
 * Toma el próximo Job pendiente cuyo `proximo_reintento_at` haya vencido
 * (o sea NULL). Race-safe entre múltiples workers: el UPDATE condicional
 * `.eq("estado","pendiente")` solo lo gana un worker por row (PostgreSQL
 * bloquea la fila durante el UPDATE), el otro lee 0 filas y sigue al próximo.
 *
 * Devuelve `null` si no hay Jobs para tomar.
 *
 * No usamos `FOR UPDATE SKIP LOCKED` (PostgREST no lo expone). En un futuro
 * multi-instancia, migrar a PG directo (chat-pg-pool) para SKIP LOCKED explícito.
 */
export async function claimNextSifenJob(
  supabase: AppSupabaseClient,
  lockOwner: string
): Promise<SifenJobDTO | null> {
  const nowIso = new Date().toISOString();

  // 1) Buscar candidatos: pendientes cuyo backoff haya expirado.
  const candidateRes = await supabase
    .from("sifen_jobs")
    .select("id")
    .eq("estado", "pendiente")
    .or(`proximo_reintento_at.is.null,proximo_reintento_at.lte.${nowIso}`)
    .order("proximo_reintento_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(5);

  if (candidateRes.error) {
    console.error("[sifen-worker] claimNextSifenJob candidates error:", candidateRes.error.message);
    return null;
  }
  const candidates = (candidateRes.data ?? []) as { id: string }[];
  if (candidates.length === 0) return null;

  // 2) Intentar claim sobre cada candidato hasta ganar uno.
  for (const c of candidates) {
    const upd = await supabase
      .from("sifen_jobs")
      .update({
        estado: "procesando",
        procesando_desde: nowIso,
        started_at: nowIso,
        lock_owner: lockOwner,
        etapa: null,
      })
      .eq("id", c.id)
      .eq("estado", "pendiente")
      .select("*")
      .maybeSingle();
    if (upd.error) {
      console.error("[sifen-worker] claim update error:", upd.error.message);
      continue;
    }
    if (upd.data) {
      return toDto(upd.data as RawJobRow);
    }
    // 0 filas → otro worker se la llevó. Probamos el siguiente candidato.
  }
  return null;
}

/** Marca la etapa activa que el worker está corriendo (para UI y logs). */
export async function setSifenJobEtapa(
  supabase: AppSupabaseClient,
  jobId: string,
  etapa: SifenJobEtapa
): Promise<void> {
  const { error } = await supabase
    .from("sifen_jobs")
    .update({ etapa })
    .eq("id", jobId);
  if (error) {
    console.warn("[sifen-worker] setSifenJobEtapa error:", error.message);
  }
}

/** Guarda tiempo (ms) por etapa. Se llama después de cada etapa exitosa. */
export async function setSifenJobEtapaTiempo(
  supabase: AppSupabaseClient,
  jobId: string,
  etapa: SifenJobEtapa,
  ms: number
): Promise<void> {
  const col =
    etapa === "xml"
      ? "tiempo_xml_ms"
      : etapa === "firmar"
        ? "tiempo_firmar_ms"
        : etapa === "enviar"
          ? "tiempo_enviar_ms"
          : "tiempo_consulta_ms";
  const { error } = await supabase
    .from("sifen_jobs")
    .update({ [col]: Math.max(0, Math.floor(ms)) })
    .eq("id", jobId);
  if (error) {
    console.warn("[sifen-worker] setSifenJobEtapaTiempo error:", error.message);
  }
}

export interface CompletarAprobadoArgs {
  cdc: string | null;
  protocoloLote: string | null;
  respuestaConsultaLote: Record<string, unknown> | null;
  respuestaRecibeLote: Record<string, unknown> | null;
  tiempoTotalMs: number;
}

/** Cierra el Job como aprobado. La factura_electronica ya quedó en 'aprobado' vía el handler. */
export async function completeSifenJobAprobado(
  supabase: AppSupabaseClient,
  jobId: string,
  args: CompletarAprobadoArgs
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("sifen_jobs")
    .update({
      estado: "aprobado",
      etapa: null,
      finished_at: nowIso,
      procesando_desde: null,
      lock_owner: null,
      cdc: args.cdc,
      protocolo_lote: args.protocoloLote,
      respuesta_consulta_lote: args.respuestaConsultaLote,
      respuesta_recibe_lote: args.respuestaRecibeLote,
      tiempo_total_ms: Math.max(0, Math.floor(args.tiempoTotalMs)),
      codigo_error_set: null,
      codigo_sub_error_set: null,
      mensaje_set: null,
      ultimo_error: null,
      tipo_error: null,
    })
    .eq("id", jobId);
  if (error) {
    console.error("[sifen-worker] completeAprobado error:", error.message);
  }
}

export interface CompletarRechazadoArgs {
  etapa: SifenJobEtapa;
  codigoErrorSet: string | null;
  codigoSubErrorSet: string | null;
  mensajeSet: string | null;
  respuestaRecibeLote: Record<string, unknown> | null;
  respuestaConsultaLote: Record<string, unknown> | null;
  tiempoTotalMs: number;
}

/** Cierra el Job como rechazado por SET (0301 u otro rechazo con código y mensaje). */
export async function completeSifenJobRechazado(
  supabase: AppSupabaseClient,
  jobId: string,
  args: CompletarRechazadoArgs
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("sifen_jobs")
    .update({
      estado: "rechazado",
      etapa: args.etapa,
      finished_at: nowIso,
      procesando_desde: null,
      lock_owner: null,
      codigo_error_set: args.codigoErrorSet,
      codigo_sub_error_set: args.codigoSubErrorSet,
      mensaje_set: args.mensajeSet,
      tipo_error: "set_rechazo",
      respuesta_recibe_lote: args.respuestaRecibeLote,
      respuesta_consulta_lote: args.respuestaConsultaLote,
      tiempo_total_ms: Math.max(0, Math.floor(args.tiempoTotalMs)),
    })
    .eq("id", jobId);
  if (error) {
    console.error("[sifen-worker] completeRechazado error:", error.message);
  }
}

export interface RegistrarIntentoArgs {
  jobActual: SifenJobDTO;
  etapa: SifenJobEtapa;
  tipoError: SifenJobTipoError;
  mensaje: string;
  tiempoMs: number;
  /** Override del backoff automático (ms). Si se omite, se usa la política
   *  por defecto (5s primer intento, 20s segundo). Se usa para casos
   *  específicos como 0301 [1264], donde SET recomienda esperar más antes
   *  de reintentar para dar tiempo a que su padrón se propague. */
  backoffOverrideMs?: number;
}

/**
 * Registra un intento fallido en `intentos_log`, incrementa `intentos`, y decide:
 *  - Si es reintentable (`red|http_5xx|storage|inesperado`) y quedan intentos:
 *    vuelve a 'pendiente' con `proximo_reintento_at = now + backoff`
 *    (5s en intento 1, 20s en intento 2).
 *  - Si NO es reintentable o se agotaron intentos: cierra como 'error' con
 *    `ultimo_error` y `tipo_error`.
 * Devuelve el nuevo estado terminal ('pendiente' si reprogramado, 'error' si cerrado).
 */
export async function registrarIntentoYPlanificar(
  supabase: AppSupabaseClient,
  args: RegistrarIntentoArgs
): Promise<"pendiente" | "error"> {
  const job = args.jobActual;
  const intentoNum = job.intentos + 1;
  const nowIso = new Date().toISOString();
  const nuevoLog: SifenJobIntento = {
    intento: intentoNum,
    at: nowIso,
    etapa: args.etapa,
    tipo_error: args.tipoError,
    mensaje: args.mensaje.slice(0, 2000),
    tiempo_ms: Math.max(0, Math.floor(args.tiempoMs)),
  };
  const log = Array.isArray(job.intentos_log) ? [...job.intentos_log, nuevoLog] : [nuevoLog];

  const reintentable =
    args.tipoError === "red" ||
    args.tipoError === "http_5xx" ||
    args.tipoError === "storage" ||
    args.tipoError === "inesperado";
  const puedeReintentar = reintentable && intentoNum < job.max_intentos_auto;

  if (puedeReintentar) {
    // Backoff: intento 1 → 5s, intento 2 → 20s (política del usuario).
    // El caller puede override con backoffOverrideMs para casos específicos
    // (p.ej. 0301 [1264] usa 30s porque suele ser transitorio de SET y
    // necesita más tiempo para que el padrón se propague).
    const backoffMs =
      args.backoffOverrideMs != null && args.backoffOverrideMs > 0
        ? args.backoffOverrideMs
        : intentoNum === 1
          ? 5_000
          : 20_000;
    const proximo = new Date(Date.now() + backoffMs).toISOString();
    const { error } = await supabase
      .from("sifen_jobs")
      .update({
        estado: "pendiente",
        etapa: null,
        intentos: intentoNum,
        intentos_log: log,
        procesando_desde: null,
        lock_owner: null,
        proximo_reintento_at: proximo,
        ultimo_error: args.mensaje.slice(0, 2000),
        tipo_error: args.tipoError,
      })
      .eq("id", job.id);
    if (error) {
      console.error("[sifen-worker] registrarIntento reintento error:", error.message);
    }
    return "pendiente";
  }

  // Terminal: 'error'.
  const { error } = await supabase
    .from("sifen_jobs")
    .update({
      estado: "error",
      etapa: args.etapa,
      intentos: intentoNum,
      intentos_log: log,
      finished_at: nowIso,
      procesando_desde: null,
      lock_owner: null,
      ultimo_error: args.mensaje.slice(0, 2000),
      tipo_error: args.tipoError,
    })
    .eq("id", job.id);
  if (error) {
    console.error("[sifen-worker] registrarIntento terminal error:", error.message);
  }
  return "error";
}

/**
 * Devuelve a 'pendiente' cualquier Job en 'procesando' con `procesando_desde`
 * anterior a `stuckThresholdMs` (default 10 minutos). Cubre crash del proceso
 * a mitad de un pipeline. Se llama periódicamente desde el worker.
 */
export async function reclaimStuckSifenJobs(
  supabase: AppSupabaseClient,
  stuckThresholdMs: number = 10 * 60 * 1000
): Promise<number> {
  const cutoff = new Date(Date.now() - stuckThresholdMs).toISOString();
  const { data, error } = await supabase
    .from("sifen_jobs")
    .update({
      estado: "pendiente",
      procesando_desde: null,
      lock_owner: null,
      etapa: null,
    })
    .eq("estado", "procesando")
    .lt("procesando_desde", cutoff)
    .select("id");
  if (error) {
    console.warn("[sifen-worker] reclaimStuck error:", error.message);
    return 0;
  }
  const n = (data ?? []).length;
  if (n > 0) {
    console.warn(`[sifen-worker] reclaimStuck: ${n} Jobs zombie devueltos a 'pendiente'`);
  }
  return n;
}

export type { SifenJobEstado };
