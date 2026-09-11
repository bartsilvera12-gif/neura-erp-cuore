/**
 * Next.js instrumentation — se ejecuta una vez cuando arranca el proceso Node
 * (o el edge runtime). Usamos este hook para bootear el worker SIFEN in-process
 * que drena la cola `sifen_jobs`.
 *
 * Soportado desde Next 15. Aplica solo cuando el runtime es `nodejs` — en
 * runtime `edge` el worker no tiene sentido (no hay setTimeout persistente).
 *
 * Deployment target: Coolify Docker (Node.js persistente). En serverless
 * (Vercel funciones edge/lambdas) este worker no funcionaría porque el
 * proceso se suspende post-response — pero Neura ERP corre en Coolify Docker
 * donde el proceso Node vive continuo, exactamente como espera el worker.
 *
 * Kill switch: setear `SIFEN_WORKER_DISABLED=1` en el env deshabilita el
 * worker (útil para rollback rápido sin cambiar código).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SIFEN_WORKER_DISABLED === "1") {
    console.log("[sifen-worker] deshabilitado por SIFEN_WORKER_DISABLED=1");
    return;
  }
  // Import dinámico: evita cargar node:os y el pool PG en el edge bundle.
  const { startSifenWorker } = await import("@/lib/sifen/jobs/sifen-worker");
  startSifenWorker();
}
