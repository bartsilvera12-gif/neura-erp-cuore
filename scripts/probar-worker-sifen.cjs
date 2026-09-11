/**
 * ¿Está vivo el worker de SIFEN en producción?
 *
 * La cola de trabajos (`sifen_jobs`) nunca se usó: la caja siempre corrió el
 * camino sincrónico, con el cajero esperando. Antes de mandar las facturas por
 * la cola hay que estar seguros de que del otro lado hay alguien atendiendo.
 * Si el worker no corre, encolar sería peor que esperar: los documentos
 * quedarían detenidos sin que nadie los procese.
 *
 * La sonda es segura: encola una factura cuyo documento YA está aprobado. El
 * worker, al tomarla, ve que está en estado terminal y cierra el trabajo sin
 * mandar ni consultar nada al SET. Lo que se mide es solamente si alguien
 * levantó el trabajo de la cola.
 *
 * Al terminar borra el trabajo de prueba, ande o no ande.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const ESPERA_MS = 30_000;
const INTERVALO_MS = 2_000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();

  let jobId = null;
  try {
    const { rows: cand } = await c.query(`
      SELECT fe.id AS fe_id, fe.factura_id, f.numero_factura
        FROM ${S}.factura_electronica fe
        JOIN ${S}.facturas f ON f.id = fe.factura_id
       WHERE fe.estado_sifen = 'aprobado'
       ORDER BY fe.created_at DESC
       LIMIT 1`);

    if (!cand[0]) {
      console.log("No hay ninguna factura aprobada para usar de sonda.");
      return;
    }
    const { fe_id, factura_id, numero_factura } = cand[0];
    const empresaId = (await c.query(`SELECT id FROM ${S}.empresas LIMIT 1`)).rows[0].id;

    console.log(`Sonda sobre ${numero_factura} (documento ya aprobado: el worker no va a tocar el SET).`);

    const ins = await c.query(
      `INSERT INTO ${S}.sifen_jobs
         (empresa_id, data_schema, factura_id, factura_electronica_id, estado, origen)
       VALUES ($1, $2, $3, $4, 'pendiente', 'manual_admin')
       RETURNING id`,
      [empresaId, S, factura_id, fe_id]
    );
    jobId = ins.rows[0].id;
    console.log(`Trabajo encolado (${jobId.slice(0, 8)}). Esperando hasta ${ESPERA_MS / 1000}s a que alguien lo tome…\n`);

    const t0 = Date.now();
    let tomado = false;

    while (Date.now() - t0 < ESPERA_MS) {
      await dormir(INTERVALO_MS);
      const { rows } = await c.query(
        `SELECT estado, etapa, lock_owner, started_at, finished_at, ultimo_error
           FROM ${S}.sifen_jobs WHERE id = $1`,
        [jobId]
      );
      const j = rows[0];
      const seg = Math.round((Date.now() - t0) / 1000);

      if (j.estado !== "pendiente" || j.lock_owner || j.started_at) {
        console.log(`  ${seg}s → estado=${j.estado} etapa=${j.etapa ?? "-"} worker=${j.lock_owner ?? "-"}`);
        tomado = true;
        if (j.finished_at) {
          console.log(`\nEL WORKER ESTÁ VIVO. Tomó el trabajo y lo cerró en ${seg}s.`);
          if (j.ultimo_error) console.log(`(cerró con: ${j.ultimo_error})`);
          break;
        }
      } else {
        console.log(`  ${seg}s → sigue pendiente, nadie lo tomó`);
      }
    }

    if (!tomado) {
      console.log(`\nEL WORKER NO RESPONDE. El trabajo quedó pendiente ${ESPERA_MS / 1000}s sin que nadie lo levante.`);
      console.log("No conviene mandar las facturas por la cola hasta resolver esto.");
      process.exitCode = 1;
    }
  } finally {
    if (jobId) {
      await c.query(`DELETE FROM ${S}.sifen_jobs WHERE id = $1`, [jobId]);
      console.log("\nTrabajo de prueba borrado: la cola quedó como estaba.");
    }
    await c.end();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
