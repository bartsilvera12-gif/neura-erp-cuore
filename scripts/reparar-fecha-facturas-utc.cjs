/**
 * Corrige la fecha de las facturas que quedaron con el día UTC.
 *
 * Mientras la fecha se leía sin convertir a hora de Paraguay, toda venta
 * posterior a las 21:00 quedaba fechada al día siguiente. Eso es la fecha de
 * emisión del documento y también la que entra en el CDC.
 *
 * Sólo se toca lo que todavía se puede tocar: facturas sin documento
 * electrónico, o con uno que nunca llegó a enviarse. Una vez que el DE se firmó
 * y se mandó, la fecha está dentro del CDC y ya no se arregla cambiando un
 * campo — hay que cancelar en la SET y reemitir. Esas se listan aparte, para
 * que alguien las resuelva a mano.
 *
 * Dry-run salvo que se pase --commit.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const OFF = "-03:00";
const COMMIT = process.argv.includes("--commit");

/** Estados en los que el CDC todavía no está comprometido ante la SET. */
const REPARABLE = new Set([null, "", "borrador", "generado", "firmado", "error", "rechazado"]);

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();

  await c.query("BEGIN");
  try {
    const { rows } = await c.query(`
      SELECT f.id,
             f.numero_factura,
             to_char(f.fecha, 'YYYY-MM-DD')                                        AS fecha_actual,
             to_char(v.fecha AT TIME ZONE INTERVAL '${OFF}', 'YYYY-MM-DD')         AS fecha_correcta,
             to_char(v.fecha AT TIME ZONE INTERVAL '${OFF}', 'YYYY-MM-DD HH24:MI') AS venta_real,
             fe.estado_sifen,
             fe.cdc
        FROM ${S}.facturas f
        JOIN ${S}.ventas v ON v.id = f.origen_venta_id
        LEFT JOIN ${S}.factura_electronica fe ON fe.factura_id = f.id
       WHERE to_char(f.fecha, 'YYYY-MM-DD')
             <> to_char(v.fecha AT TIME ZONE INTERVAL '${OFF}', 'YYYY-MM-DD')
       ORDER BY f.numero_factura`);

    if (rows.length === 0) {
      console.log("No hay facturas con la fecha corrida.");
      await c.query("ROLLBACK");
      await c.end();
      return;
    }

    const reparables = rows.filter((r) => REPARABLE.has(r.estado_sifen));
    const aMano = rows.filter((r) => !REPARABLE.has(r.estado_sifen));

    console.log(`${rows.length} factura(s) con la fecha corrida.\n`);

    for (const r of reparables) {
      console.log(`${r.numero_factura}: ${r.fecha_actual} → ${r.fecha_correcta}   (venta real ${r.venta_real}, DE ${r.estado_sifen ?? "sin generar"})`);
      await c.query(
        `UPDATE ${S}.facturas SET fecha = $1::date, fecha_vencimiento = $1::date, updated_at = now()
          WHERE id = $2`,
        [r.fecha_correcta, r.id]
      );
    }

    if (aMano.length > 0) {
      console.log(`\nEstas ya se mandaron a la SET y la fecha está dentro del CDC.`);
      console.log(`No se tocan: hay que cancelarlas en la SET y reemitirlas.`);
      for (const r of aMano) {
        console.log(`  ${r.numero_factura}: dice ${r.fecha_actual}, la venta fue ${r.venta_real} (DE ${r.estado_sifen})`);
        console.log(`     CDC ${r.cdc}`);
      }
    }

    console.log(`\n${reparables.length} corregida(s), ${aMano.length} para resolver a mano.`);

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
