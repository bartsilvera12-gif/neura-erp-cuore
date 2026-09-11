/**
 * Deja el KUDE saliendo por tickeadora de 80 mm y carga el contacto del emisor.
 *
 * Son datos de configuración, no de código: el formato del comprobante y el
 * teléfono/email que se imprimen salen de la configuración de facturación, así
 * que cambiarlos mañana no necesita un deploy.
 *
 * Dry-run salvo que se pase --commit.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const COMMIT = process.argv.includes("--commit");

const CONFIG = {
  /** pdf_a4 | ticket_58mm | ticket_80mm */
  impresion: "ticket_80mm",
  telefono: "0993 558500",
  email: "cmaidana111@gmail.com",
};

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  await c.query("BEGIN");
  try {
    const modo = await c.query(
      `update ${S}.empresa_facturacion_modo
          set impresion_tipo_default = $2, updated_at = now()
        where empresa_id = $1
        returning modo, impresion_tipo_default`,
      [empresaId, CONFIG.impresion]
    );
    if (modo.rowCount === 0) {
      await c.query(
        `insert into ${S}.empresa_facturacion_modo (empresa_id, modo, impresion_tipo_default)
         values ($1, 'sifen', $2)`,
        [empresaId, CONFIG.impresion]
      );
      console.log(`facturacion_modo: creado con impresion = ${CONFIG.impresion}`);
    } else {
      console.log(`facturacion_modo: modo=${modo.rows[0].modo}, impresion=${modo.rows[0].impresion_tipo_default}`);
    }

    const cfg = await c.query(
      `update ${S}.empresa_sifen_config
          set emisor_telefono = $2, emisor_email = $3, updated_at = now()
        where empresa_id = $1
        returning ruc, razon_social, emisor_telefono, emisor_email`,
      [empresaId, CONFIG.telefono, CONFIG.email]
    );
    if (cfg.rowCount === 0) {
      console.log("sifen_config: NO existe todavía. Cargá primero la configuración de SIFEN y volvé a correr esto.");
    } else {
      console.table(cfg.rows);
    }

    if (COMMIT) {
      await c.query("COMMIT");
      console.log("\nCOMMIT aplicado.");
    } else {
      await c.query("ROLLBACK");
      console.log("\nDRY-RUN: nada se guardó. Volvé a correr con --commit.");
    }
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
