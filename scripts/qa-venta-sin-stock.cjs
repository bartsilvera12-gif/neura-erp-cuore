/**
 * Prueba en transacción con ROLLBACK de que se puede vender sin stock.
 *
 * Antes la venta se cortaba si el conteo no alcanzaba. En el mostrador eso es
 * peor que el problema que evita: el cliente ya tiene la cerveza en la mano y
 * la caja se niega a cobrarla porque el sistema dice cero.
 *
 * Lo que se verifica:
 *   · la venta se registra igual;
 *   · el stock queda en NEGATIVO, no recortado a cero — el negativo es la marca
 *     visible de que el conteo está mal;
 *   · el movimiento de inventario se genera igual, así el historial cierra;
 *   · cargar después la compra que faltaba devuelve el stock a un número sano.
 *
 * No deja nada en la base.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    // Un producto de reventa con 2 unidades contadas.
    const prodId = (await c.query(
      `insert into ${S}.productos (empresa_id, nombre, sku, controla_stock, es_vendible,
                                   stock_actual, precio_venta, costo_promedio, activo)
       values ($1,'CERVEZA QA','QA-CERV',true,true,2,15000,10000,true)
       returning id`,
      [empresaId]
    )).rows[0].id;

    const stockDe = async () =>
      Number((await c.query(`select stock_actual from ${S}.productos where id=$1`, [prodId])).rows[0].stock_actual);

    console.log(`Stock contado al empezar: ${await stockDe()} u.`);

    // Se venden 5 teniendo 2: el caso que antes cortaba la venta.
    const ventaId = (await c.query(
      `insert into ${S}.ventas (empresa_id, numero_control, subtotal, monto_iva, total, fecha)
       values ($1,'VTA-QA-SINSTOCK',68182,6818,75000, now()) returning id`,
      [empresaId]
    )).rows[0].id;

    await c.query(
      `insert into ${S}.ventas_items (empresa_id, venta_id, producto_id, producto_nombre, sku,
                                      cantidad, precio_venta, precio_venta_original, subtotal, monto_iva, total_linea, tipo_iva)
       values ($1,$2,$3,'CERVEZA QA','QA-CERV',5,15000,15000,68182,6818,75000,'10%')`,
      [empresaId, ventaId, prodId]
    );
    await c.query(`update ${S}.productos set stock_actual = stock_actual - 5 where id=$1`, [prodId]);
    await c.query(
      `insert into ${S}.movimientos_inventario (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad, origen, referencia)
       values ($1,$2,'CERVEZA QA','QA-CERV','SALIDA',5,'venta','VTA-QA-SINSTOCK')`,
      [empresaId, prodId]
    );

    const trasVenta = await stockDe();
    console.log(`Se vendieron 5. Stock: ${trasVenta} u.`);

    const venta = (await c.query(`select estado from ${S}.ventas where id=$1`, [ventaId])).rows[0];
    if (!venta) fallar("la venta no quedó registrada");

    if (trasVenta !== -3) {
      fallar(`el stock tenía que quedar en -3 y quedó en ${trasVenta}`);
    }
    if (trasVenta === 0) {
      fallar("el stock se recortó a cero: el faltante queda invisible");
    }

    const mov = await c.query(
      `select count(*)::int as n from ${S}.movimientos_inventario
        where producto_id=$1 and referencia='VTA-QA-SINSTOCK'`, [prodId]);
    if (mov.rows[0].n !== 1) fallar("no se registró el movimiento de inventario");
    else console.log("El movimiento de inventario se registró igual.");

    // Al cargar la compra que faltaba, el negativo se acomoda solo.
    await c.query(`update ${S}.productos set stock_actual = stock_actual + 12 where id=$1`, [prodId]);
    const trasCompra = await stockDe();
    console.log(`Se carga una compra de 12. Stock: ${trasCompra} u.`);
    if (trasCompra !== 9) {
      fallar(`tras la compra el stock tenía que dar 9 y dio ${trasCompra}`);
    }

    console.log(`\n${fallos === 0 ? "VENTA SIN STOCK OK" : `${fallos} FALLO(S)`}`);
    if (fallos > 0) process.exitCode = 1;
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
