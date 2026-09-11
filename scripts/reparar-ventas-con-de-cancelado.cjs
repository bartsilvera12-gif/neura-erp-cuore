/**
 * Pone al día las ventas cuyo documento electrónico ya está cancelado en el SET
 * pero que quedaron marcadas como vigentes.
 *
 * Es el arrastre de las cancelaciones hechas antes de que el ERP supiera anular
 * la venta: el documento está cancelado y la factura anulada, pero la venta
 * seguía sumando al arqueo de caja y a los reportes, y el stock descontado no
 * había vuelto.
 *
 * Hace lo mismo que hace hoy la cancelación: devuelve el stock con su
 * movimiento y marca la venta anulada. No toca las que ya están anuladas ni las
 * que no tienen documento cancelado.
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
    const { rows: pendientes } = await c.query(`
      SELECT v.id, v.numero_control, v.empresa_id, v.total::float8 total, f.numero_factura
        FROM ${S}.ventas v
        JOIN ${S}.facturas f ON f.id = v.factura_id
        JOIN ${S}.factura_electronica fe ON fe.factura_id = f.id
       WHERE fe.estado_sifen = 'cancelado'
         AND v.estado <> 'anulada'
       ORDER BY v.numero_control`);

    if (pendientes.length === 0) {
      console.log("No hay ventas para poner al día.");
      await c.query("ROLLBACK");
      await c.end();
      return;
    }

    console.table(pendientes.map((p) => ({ venta: p.numero_control, factura: p.numero_factura, total: p.total })));

    let devueltos = 0;
    for (const v of pendientes) {
      // Devolución de stock: una entrada por cada salida que generó la venta.
      const { rows: salidas } = await c.query(
        `SELECT producto_id, producto_nombre, producto_sku, cantidad::float8 cantidad,
                costo_unitario::float8 costo
           FROM ${S}.movimientos_inventario
          WHERE empresa_id=$1 AND venta_id=$2 AND origen='venta' AND tipo='SALIDA'`,
        [v.empresa_id, v.id]
      );
      for (const s of salidas) {
        if (s.cantidad <= 0) continue;
        await c.query(
          `UPDATE ${S}.productos SET stock_actual = stock_actual + $1, updated_at = now()
            WHERE id=$2 AND empresa_id=$3`,
          [s.cantidad, s.producto_id, v.empresa_id]
        );
        await c.query(
          `INSERT INTO ${S}.movimientos_inventario
             (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
              costo_unitario, origen, referencia, fecha, venta_id)
           VALUES ($1,$2,$3,$4,'ENTRADA',$5,$6,'venta',$7, now(), $8)`,
          [v.empresa_id, s.producto_id, s.producto_nombre, s.producto_sku, s.cantidad,
           s.costo, `Anulación ${v.numero_control}`, v.id]
        );
        devueltos++;
      }

      await c.query(
        `UPDATE ${S}.ventas
            SET estado='anulada', anulada_at=now(),
                anulacion_motivo=$1, updated_at=now()
          WHERE id=$2 AND empresa_id=$3`,
        [`Documento ${v.numero_factura} cancelado en el SET`, v.id, v.empresa_id]
      );
    }

    console.log(`\n${pendientes.length} venta(s) marcadas anuladas, ${devueltos} línea(s) devolvieron stock.`);

    const { rows: quedan } = await c.query(`
      SELECT v.numero_control, v.estado
        FROM ${S}.ventas v ORDER BY v.numero_control`);
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
