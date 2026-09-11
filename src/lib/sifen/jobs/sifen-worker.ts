import os from "node:os";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  claimNextSifenJob,
  reclaimStuckSifenJobs,
} from "@/lib/sifen/jobs/sifen-jobs-repo";
import { runSifenJob } from "@/lib/sifen/jobs/run-sifen-job";

/**
 * Worker in-process para drenar la cola `sifen_jobs`.
 *
 * Diseño:
 *  - Un solo worker por proceso Node (singleton por globalThis).
 *  - Loop `setTimeout` recursivo (mejor que setInterval — evita solapamiento
 *    si un Job tarda más de un tick).
 *  - Tick corto (2s) cuando hay actividad reciente, tick largo (5s) cuando
 *    la cola está vacía (menos presión a Supabase).
 *  - Reclaim periódico de Jobs zombie cada 60s.
 *  - Toma UN Job por tick (no paraleliza) — SIFEN local es una operación
 *    pesada (firma XML-DSig, SOAP HTTPS a SET). Paralelizar 2 Jobs solo tendría
 *    sentido en volumen alto y multi-tenant; en ese caso escalar a N réplicas.
 *
 * El cliente Supabase para el CLAIM se resuelve con service role sobre el
 * schema principal (NEURA_CLIENT_SCHEMA). El cliente para EJECUTAR el Job se
 * resuelve dentro de `runSifenJob` a partir de `job.empresa_id` — así el
 * mismo worker puede drenar Jobs de múltiples tenants si el día de mañana
 * corren varios en la misma instancia.
 */

const GLOBAL_STARTED_KEY = "__neura_SIFEN_WORKER_STARTED__" as const;
const GLOBAL_STOP_KEY = "__neura_SIFEN_WORKER_STOP__" as const;

/** Identificador único del proceso: hostname:pid — se guarda en `lock_owner`. */
function buildLockOwner(): string {
  const host = os.hostname();
  const pid = process.pid;
  return `${host}:${pid}`;
}

const LOCK_OWNER = buildLockOwner();
/**
 * Cada cuánto el worker mira si hay trabajo.
 *
 * Medido sobre facturas reales, un documento pasaba unos 2 segundos esperando a
 * que alguien lo levantara: tiempo muerto, con la factura ya lista para salir y
 * el cliente esperando en el mostrador.
 *
 * Bajar el tick lo recorta casi por completo. El costo es una consulta más
 * seguida a la base cuando no hay nada que hacer, que para un solo local es
 * despreciable: es un SELECT sobre un índice.
 */
const TICK_ACTIVO_MS = 300;
const TICK_IDLE_MS = 1_000;
const RECLAIM_INTERVAL_MS = 60_000;

interface WorkerState {
  running: boolean;
  lastReclaimAt: number;
}

function claimSupabase(): AppSupabaseClient {
  // Service role sobre el schema por defecto (NEURA_CLIENT_SCHEMA).
  // La tabla sifen_jobs vive en cada tenant; en la instancia dedicada de
  // Reserva Ecológica Caacupé es un solo schema. Para multi-schema real
  // habría que iterar por tenant activo — ver README de Fase 3.
  return createServiceRoleClient();
}

async function loop(state: WorkerState): Promise<void> {
  const stopFn = readGlobalStop();
  if (stopFn && stopFn.stopped) return;

  const sb = claimSupabase();
  let hadWork = false;

  // Reclaim periódico.
  if (Date.now() - state.lastReclaimAt > RECLAIM_INTERVAL_MS) {
    try {
      await reclaimStuckSifenJobs(sb);
    } catch (e) {
      console.warn("[sifen-worker] reclaim tick error:", e);
    }
    state.lastReclaimAt = Date.now();
  }

  // Claim y ejecutar un Job (si hay).
  try {
    const job = await claimNextSifenJob(sb, LOCK_OWNER);
    if (job) {
      hadWork = true;
      console.log(
        `[sifen-worker] tomó Job ${job.id} empresa=${job.empresa_id} factura=${job.factura_id} intento=${job.intentos + 1}/${job.max_intentos_auto}`
      );
      try {
        await runSifenJob(job);
      } catch (e) {
        // runSifenJob ya captura y clasifica; esto es un fallback.
        console.error(`[sifen-worker] runSifenJob excepción no capturada:`, e);
      }
    }
  } catch (e) {
    console.error("[sifen-worker] claim tick error:", e);
  }

  const delay = hadWork ? TICK_ACTIVO_MS : TICK_IDLE_MS;
  scheduleNext(state, delay);
}

function scheduleNext(state: WorkerState, delayMs: number): void {
  const stopFn = readGlobalStop();
  if (stopFn && stopFn.stopped) return;
  setTimeout(() => {
    void loop(state);
  }, delayMs);
}

interface StopHandle {
  stopped: boolean;
}

function readGlobalStop(): StopHandle | undefined {
  const g = globalThis as unknown as Record<string, StopHandle | undefined>;
  return g[GLOBAL_STOP_KEY];
}

function writeGlobalStop(h: StopHandle): void {
  const g = globalThis as unknown as Record<string, StopHandle | undefined>;
  g[GLOBAL_STOP_KEY] = h;
}

function alreadyStarted(): boolean {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  return g[GLOBAL_STARTED_KEY] === true;
}

function markStarted(): void {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  g[GLOBAL_STARTED_KEY] = true;
}

/**
 * Arranca el worker una sola vez por proceso. Idempotente: llamar múltiples
 * veces (p.ej. hot-reload en dev) es seguro — el flag global lo protege.
 *
 * Se llama desde `src/instrumentation.ts` cuando el runtime es `nodejs`.
 * No hace nada en runtime `edge` ni en workers de Next (no aplica ahí).
 */
export function startSifenWorker(): void {
  if (alreadyStarted()) {
    console.log("[sifen-worker] ya iniciado, ignorando");
    return;
  }
  markStarted();
  const stopHandle: StopHandle = { stopped: false };
  writeGlobalStop(stopHandle);

  const state: WorkerState = {
    running: true,
    lastReclaimAt: 0,
  };

  console.log(`[sifen-worker] arrancando (lock_owner=${LOCK_OWNER})`);

  // Cierre graceful: al recibir SIGTERM/SIGINT, detener el loop antes de
  // que el proceso muera. Jobs en 'procesando' quedan con `procesando_desde`
  // y serán reclamados por el próximo boot vía `reclaimStuckSifenJobs`.
  const shutdown = (sig: string) => {
    console.log(`[sifen-worker] ${sig} recibido — deteniendo loop`);
    stopHandle.stopped = true;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Primer tick con delay corto para no interferir con el boot de Next.
  setTimeout(() => {
    void loop(state);
  }, 3_000);
}
