/**
 * Prueba en transacción con ROLLBACK del puente venta → factura.
 *
 * Reproduce lo que hace facturarVentaPg contra la base real y verifica que la
 * factura salga con el mismo detalle que se cobró, que quede atada a su venta
 * en los dos sentidos y que una venta no se pueda facturar dos veces.
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

  const prods = (
    await c.query(
      `select id, nombre, precio_venta::float8 precio from ${S}.productos
        where empresa_id=$1 and es_vendible and precio_venta > 0 order by nombre limit 2`,
      [empresaId]
    )
  ).rows;
  if (prods.length < 2) throw new Error("Hacen falta 2 productos vendibles con precio.");

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    // ── Venta de prueba, con dos líneas y dos tipos de IVA ────────────────
    const lineas = prods.map((p, i) => {
      const cantidad = i + 1;
      const total = Math.round(p.precio * cantidad);
      const tipoIva = i === 0 ? "10%" : "5%";
      const iva = tipoIva === "10%" ? total / 11 : total / 21;
      return { p, cantidad, total, tipoIva, iva, subtotal: total - iva };
    });
    const totalVenta = lineas.reduce((a, l) => a + l.total, 0);
    const ivaVenta = lineas.reduce((a, l) => a + l.iva, 0);

    const ventaId = (
      await c.query(
        `insert into ${S}.ventas (empresa_id, numero_control, subtotal, monto_iva, total,
                                  observaciones, metodo_pago, fecha)
         values ($1,'VTA-QA0001',$2,$3,$4,'Mesa 3','efectivo', now()) returning id`,
        [empresaId, totalVenta - ivaVenta, ivaVenta, totalVenta]
      )
    ).rows[0].id;

    for (const l of lineas) {
      await c.query(
        `insert into ${S}.ventas_items (empresa_id, venta_id, producto_id, producto_nombre, sku,
           cantidad, precio_venta_original, precio_venta, tipo_iva, subtotal, monto_iva, total_linea)
         values ($1,$2,$3,$4,'', $5,$6,$6,$7,$8,$9,$10)`,
        [empresaId, ventaId, l.p.id, l.p.nombre, l.cantidad, l.p.precio,
         l.tipoIva, l.subtotal, l.iva, l.total]
      );
    }

    // ── Lo que hace facturarVentaPg ───────────────────────────────────────
    async function facturar(razonSocial, ruc, documento = null) {
      const v = (
        await c.query(
          `select id, factura_id, estado, cliente_id, total::float8 total, tipo_venta, moneda,
                  observaciones, to_char(fecha,'YYYY-MM-DD') fecha_dia
             from ${S}.ventas where id=$1 and empresa_id=$2 for update`,
          [ventaId, empresaId]
        )
      ).rows[0];
      if (v.factura_id) return { yaFacturada: true, facturaId: v.factura_id };

      const items = (
        await c.query(
          `select producto_nombre, item_display_name, cantidad::float8 cantidad,
                  precio_venta::float8 precio, subtotal::float8 subtotal,
                  monto_iva::float8 iva, total_linea::float8 total, tipo_iva
             from ${S}.ventas_items where venta_id=$1 and empresa_id=$2 order by created_at`,
          [ventaId, empresaId]
        )
      ).rows;

      const maxn = (
        await c.query(
          `select coalesce(max(case when numero_factura ~ '^FAC-[0-9]+$'
                   then (substring(numero_factura from 5))::int else 0 end),0) m
             from ${S}.facturas where empresa_id=$1`, [empresaId])
      ).rows[0].m;
      const numero = `FAC-${String(Number(maxn) + 1).padStart(6, "0")}`;

      const fid = (
        await c.query(
          `insert into ${S}.facturas (empresa_id, cliente_id, numero_factura, fecha, fecha_vencimiento,
             monto, saldo, estado, tipo, moneda, cliente_razon_social, cliente_ruc,
             cliente_documento, observaciones, origen_venta_id)
           values ($1,$2,$3,$4::date,$4::date,$5,0,'Pagado','contado','GS',$6,$7,$8,$9,$10)
           returning id`,
          [empresaId, v.cliente_id, numero, v.fecha_dia, v.total,
           razonSocial, ruc, documento, v.observaciones, ventaId]
        )
      ).rows[0].id;

      for (const it of items) {
        await c.query(
          `insert into ${S}.factura_items (empresa_id, factura_id, descripcion, cantidad,
             precio_unitario, subtotal, iva, total, tipo_iva)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [empresaId, fid, it.item_display_name || it.producto_nombre, it.cantidad,
           it.precio, it.subtotal, it.iva, it.total, it.tipo_iva]
        );
      }
      await c.query(`update ${S}.ventas set factura_id=$1 where id=$2 and empresa_id=$3`,
        [fid, ventaId, empresaId]);
      return { yaFacturada: false, facturaId: fid, numero };
    }

    const r1 = await facturar("PANADERIA SAN JUAN SRL", "80012345-6");
    console.log(`Factura emitida: ${r1.numero}`);

    // ── Verificaciones ────────────────────────────────────────────────────
    const f = (
      await c.query(
        `select numero_factura, monto::float8 monto, cliente_razon_social, cliente_ruc,
                cliente_documento, origen_venta_id, observaciones, estado
           from ${S}.facturas where id=$1`, [r1.facturaId])
    ).rows[0];
    console.table([f]);

    if (Math.abs(f.monto - totalVenta) > 1e-6)
      fallar(`el monto de la factura (${f.monto}) no es el de la venta (${totalVenta})`);
    if (f.origen_venta_id !== ventaId) fallar("la factura no apunta a su venta");
    if (f.cliente_ruc !== "80012345-6") fallar("no se guardó el RUC");
    if (f.observaciones !== "Mesa 3") fallar("no se arrastró la observación de la venta");

    const link = (await c.query(`select factura_id from ${S}.ventas where id=$1`, [ventaId])).rows[0];
    if (link.factura_id !== r1.facturaId) fallar("la venta no quedó apuntando a su factura");

    const fi = (
      await c.query(
        `select descripcion, cantidad::float8 cantidad, total::float8 total, tipo_iva
           from ${S}.factura_items where factura_id=$1 order by descripcion`, [r1.facturaId])
    ).rows;
    console.table(fi);
    if (fi.length !== lineas.length)
      fallar(`la factura tiene ${fi.length} ítems y la venta ${lineas.length}`);
    const sumaItems = fi.reduce((a, x) => a + x.total, 0);
    if (Math.abs(sumaItems - totalVenta) > 1e-6)
      fallar(`los ítems suman ${sumaItems} y la factura dice ${f.monto}`);
    const ivas = new Set(fi.map((x) => x.tipo_iva));
    if (!ivas.has("10%") || !ivas.has("5%"))
      fallar(`se perdió el desglose de IVA por ítem: ${[...ivas].join(",")}`);

    // Facturar de nuevo tiene que reconocer que ya está hecha.
    const r2 = await facturar("OTRO", "111-1");
    if (!r2.yaFacturada) fallar("dejó facturar dos veces la misma venta");

    // Y la base tiene que impedirlo aunque el código falle.
    let bloqueado = false;
    try {
      await c.query("SAVEPOINT dup");
      await c.query(
        `insert into ${S}.facturas (empresa_id, numero_factura, fecha, fecha_vencimiento,
           monto, tipo, origen_venta_id)
         values ($1,'FAC-DUP',current_date,current_date,1,'contado',$2)`,
        [empresaId, ventaId]
      );
      await c.query("RELEASE SAVEPOINT dup");
    } catch {
      bloqueado = true;
      await c.query("ROLLBACK TO SAVEPOINT dup");
    }
    if (!bloqueado) fallar("la base permite dos facturas para la misma venta");

    console.log(`\n${fallos === 0 ? "PUENTE VENTA → FACTURA OK" : `${fallos} FALLO(S)`}`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
