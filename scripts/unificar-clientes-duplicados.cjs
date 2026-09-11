/**
 * Junta las fichas de cliente repetidas por RUC (o cédula) en una sola.
 *
 * Arrastre de cuando la caja daba de alta un cliente por cada factura sin
 * fijarse si ese RUC ya estaba cargado: el buscador mostraba el mismo nombre
 * varias veces y cada factura apuntaba a una ficha distinta.
 *
 * Conserva la ficha más antigua — es la que puede tener datos completados a
 * mano — repunta las facturas y las ventas a ella, y da de baja lógica a las
 * demás. No borra nada de forma definitiva.
 *
 * Dry-run salvo que se pase --commit.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const COMMIT = process.argv.includes("--commit");

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();

  await c.query("BEGIN");
  try {
    const { rows: grupos } = await c.query(`
      SELECT COALESCE(NULLIF(TRIM(ruc), ''), NULLIF(TRIM(documento), '')) AS identificacion,
             empresa_id,
             array_agg(id ORDER BY created_at) AS ids,
             count(*)::int AS n
        FROM ${S}.clientes
       WHERE deleted_at IS NULL
         AND COALESCE(NULLIF(TRIM(ruc), ''), NULLIF(TRIM(documento), '')) IS NOT NULL
       GROUP BY 1, 2
      HAVING count(*) > 1`);

    if (grupos.length === 0) {
      console.log("No hay clientes repetidos.");
      await c.query("ROLLBACK");
      await c.end();
      return;
    }

    let fusionados = 0;
    let facturasRe = 0;
    let ventasRe = 0;

    for (const g of grupos) {
      const [conservar, ...sobran] = g.ids;
      console.log(`\n${g.identificacion}: ${g.n} fichas → se conserva ${conservar.slice(0, 8)}`);

      for (const viejo of sobran) {
        const f = await c.query(
          `UPDATE ${S}.facturas SET cliente_id=$1, updated_at=now()
            WHERE cliente_id=$2 AND empresa_id=$3`,
          [conservar, viejo, g.empresa_id]
        );
        const v = await c.query(
          `UPDATE ${S}.ventas SET cliente_id=$1, updated_at=now()
            WHERE cliente_id=$2 AND empresa_id=$3`,
          [conservar, viejo, g.empresa_id]
        );
        await c.query(
          `UPDATE ${S}.clientes
              SET deleted_at = now(),
                  deletion_reason = $1,
                  updated_at = now()
            WHERE id=$2 AND empresa_id=$3`,
          [`Ficha repetida: se unificó en ${conservar}`, viejo, g.empresa_id]
        );
        facturasRe += f.rowCount ?? 0;
        ventasRe += v.rowCount ?? 0;
        fusionados++;
        console.log(`  · ${viejo.slice(0, 8)} dada de baja (${f.rowCount} factura(s), ${v.rowCount} venta(s) repuntadas)`);
      }
    }

    console.log(`\n${fusionados} ficha(s) unificadas, ${facturasRe} factura(s) y ${ventasRe} venta(s) repuntadas.`);

    const { rows: quedan } = await c.query(
      `SELECT COALESCE(nombre_facturacion, empresa, nombre) razon, ruc, documento
         FROM ${S}.clientes WHERE deleted_at IS NULL ORDER BY razon`
    );
    console.table(quedan);

    if (COMMIT) {
      await c.query("COMMIT");
      console.log("COMMIT aplicado.");
    } else {
      await c.query("ROLLBACK");
      console.log("DRY-RUN: nada se guardó. Volvé a correr con --commit.");
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
