/**
 * Prueba en transacción con ROLLBACK de la compra de varias líneas.
 *
 * Reproduce lo que hace insertCompraMultilinea contra la base real y verifica
 * que: las tres líneas compartan numero_control, que cada producto sume su
 * propio stock, que quede un movimiento ENTRADA por línea y que el costo y el
 * precio de cada producto queden en lo que dice su línea.
 *
 * No deja nada en la base.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";

function calc(cantidad, costo, ivaTipo) {
  const total = cantidad * costo;
  const montoIva = ivaTipo === "exenta" ? 0 : ivaTipo === "5" ? total / 21 : total / 11;
  return { total, montoIva, subtotal: total - montoIva };
}

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();

  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  // Tres insumos cualesquiera que ya existan, para no inventar productos.
  const prods = (
    await c.query(
      `select id, nombre, stock_actual::float8 stock, costo_promedio::float8 costo, precio_venta::float8 precio
         from ${S}.productos where empresa_id=$1 and es_insumo order by nombre limit 3`,
      [empresaId]
    )
  ).rows;
  if (prods.length < 3) throw new Error("Hacen falta 3 productos para la prueba.");

  const lineas = [
    { p: prods[0], cantidad: 10, costo: 12000, iva: "10", precio: 20000 },
    { p: prods[1], cantidad: 2.5, costo: 40000, iva: "5", precio: 60000 },
    // precio 0 = la linea no trae precio de venta: el producto conserva el suyo.
    { p: prods[2], cantidad: 7, costo: 5000, iva: "exenta", precio: 0 },
  ];

  await c.query("BEGIN");
  try {
    // Proveedor de prueba: la FK exige uno real.
    const prov = (
      await c.query(
        `insert into ${S}.proveedores (empresa_id, nombre, ruc, estado)
         values ($1,'PROVEEDOR TEST QA','99999999-9','activo') returning id, nombre`,
        [empresaId]
      )
    ).rows[0];

    const numero = "COMP-QA0001";

    for (const l of lineas) {
      const k = calc(l.cantidad, l.costo, l.iva);
      await c.query(
        `insert into ${S}.compras (
           empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
           cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
           iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
           tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha
         ) values ($1,$2,$3,$4,$5, $6,'PYG',1,$7,$7, $8,$9,$10,$11,$12,0,
                   'contado',null,'001-001-0000001',$13,'registrada',now())`,
        [empresaId, prov.id, prov.nombre, l.p.id, l.p.nombre,
         l.cantidad, l.costo, l.iva, k.subtotal, k.montoIva, k.total, l.precio, numero]
      );
      await c.query(
        `insert into ${S}.movimientos_inventario
           (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
            costo_unitario, origen, referencia, fecha)
         select $1,$2,$3, coalesce(p.sku,''), 'ENTRADA', $4, $5, 'compra', $6, now()
           from ${S}.productos p where p.id = $2`,
        [empresaId, l.p.id, l.p.nombre, l.cantidad, l.costo, numero]
      );
      await c.query(
        `update ${S}.productos
            set stock_actual = stock_actual + $1, costo_promedio = $2,
                precio_venta = case when $3 > 0 then $3 else precio_venta end,
                updated_at = now()
          where id = $4 and empresa_id = $5`,
        [l.cantidad, l.costo, l.precio, l.p.id, empresaId]
      );
    }

    // ── Verificaciones ────────────────────────────────────────────────────
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    const filas = (
      await c.query(
        `select producto_nombre, cantidad::float8 cantidad, total::float8 total,
                monto_iva::float8 iva, iva_tipo
           from ${S}.compras where numero_control=$1 order by producto_nombre`,
        [numero]
      )
    ).rows;
    console.table(filas);
    if (filas.length !== 3) fallar(`se esperaban 3 líneas y hay ${filas.length}`);

    const nums = (
      await c.query(`select count(distinct numero_control)::int n from ${S}.compras where empresa_id=$1`, [empresaId])
    ).rows[0].n;
    if (nums !== 1) fallar(`las líneas quedaron en ${nums} números de control, no en 1`);

    const movs = (
      await c.query(`select count(*)::int n from ${S}.movimientos_inventario where referencia=$1`, [numero])
    ).rows[0].n;
    if (movs !== 3) fallar(`se esperaban 3 movimientos ENTRADA y hay ${movs}`);

    for (const l of lineas) {
      const r = (
        await c.query(
          `select stock_actual::float8 stock, costo_promedio::float8 costo, precio_venta::float8 precio
             from ${S}.productos where id=$1`,
          [l.p.id]
        )
      ).rows[0];
      const esperado = l.p.stock + l.cantidad;
      if (Math.abs(r.stock - esperado) > 1e-9)
        fallar(`${l.p.nombre}: stock ${r.stock}, se esperaba ${esperado}`);
      if (Math.abs(r.costo - l.costo) > 1e-9)
        fallar(`${l.p.nombre}: costo ${r.costo}, se esperaba ${l.costo}`);
      // Con precio 0 la linea no toca el precio de venta del producto.
      const precioEsperado = l.precio > 0 ? l.precio : l.p.precio;
      if (Math.abs(r.precio - precioEsperado) > 1e-9)
        fallar(`${l.p.nombre}: precio ${r.precio}, se esperaba ${precioEsperado}`);
    }

    // El IVA va incluido: gravada + iva tiene que dar el total de cada línea.
    for (const f of filas) {
      const sub = (
        await c.query(`select subtotal::float8 s from ${S}.compras where numero_control=$1 and producto_nombre=$2`,
          [numero, f.producto_nombre])
      ).rows[0].s;
      if (Math.abs(sub + f.iva - f.total) > 1e-6)
        fallar(`${f.producto_nombre}: gravada + IVA (${sub + f.iva}) no da el total (${f.total})`);
    }

    const totalFactura = filas.reduce((a, f) => a + f.total, 0);
    console.log(`\nTotal de la factura: Gs. ${Math.round(totalFactura).toLocaleString("es-PY")}`);
    console.log(fallos === 0 ? "COMPRA MULTILÍNEA OK" : `${fallos} FALLO(S)`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
