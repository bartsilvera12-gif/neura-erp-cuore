/**
 * Prueba en transacción con ROLLBACK de la edición del pedido de una mesa.
 *
 * Reproduce lo que hace actualizarItemPg y verifica el caso que motivó el
 * cambio: se cargaron pizzas del sabor equivocado y hay que corregirlas sin
 * rehacer el pedido. Comprueba que al cambiar el producto se recalculen precio
 * y total, que se limpien las columnas de mitad y mitad, y que una línea ya
 * enviada a cocina no se pueda editar.
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

  // Dos pizzas de precio distinto: el cambio tiene que mover el total.
  const pizzas = (
    await c.query(
      `select id, nombre, precio_venta::float8 precio from ${S}.productos
        where empresa_id=$1 and nombre like 'PIZZA %' and precio_venta > 0
        order by precio_venta limit 2`,
      [empresaId]
    )
  ).rows;
  if (pizzas.length < 2) throw new Error("Hacen falta 2 pizzas con precio.");
  const [barata, cara] = pizzas;

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    const mesaId = (
      await c.query(
        `insert into ${S}.mesas (empresa_id, numero, estado) values ($1, 9999, 'ocupada')
         returning id`, [empresaId])
    ).rows[0].id;
    const sesionId = (
      await c.query(
        `insert into ${S}.mesa_sesiones (empresa_id, mesa_id, tipo, estado)
         values ($1,$2,'mesa','abierta') returning id`, [empresaId, mesaId])
    ).rows[0].id;

    /** Agrega una línea, como agregarItemPg. */
    async function agregar(prod, cantidad, mitad = null, displayName = null, precio = null) {
      const p = precio ?? prod.precio;
      return (
        await c.query(
          `insert into ${S}.mesa_sesion_items
             (empresa_id, sesion_id, producto_id, producto_nombre, sku, cantidad,
              precio_unitario, total, estado, es_mitad_mitad, mitad_1_nombre,
              mitad_2_nombre, item_display_name)
           values ($1,$2,$3,$4,'',$5,$6,$7,'pendiente',$8,$9,$10,$11) returning id`,
          [empresaId, sesionId, prod.id, displayName || prod.nombre, cantidad, p,
           Math.round(p * cantidad), !!mitad, mitad?.n1 ?? null, mitad?.n2 ?? null, displayName]
        )
      ).rows[0].id;
    }

    /** Lo que hace actualizarItemPg al cambiar el producto de una línea. */
    async function cambiarProducto(itemId, prod, { mitad = null, displayName = null, precioOverride = null } = {}) {
      const cur = (
        await c.query(
          `select precio_unitario::float8 precio, cantidad::float8 cantidad, estado
             from ${S}.mesa_sesion_items where id=$1 and empresa_id=$2`, [itemId, empresaId])
      ).rows[0];
      if (cur.estado !== "pendiente") return { error: "El producto ya fue enviado a comanda; no se puede editar." };
      const precio = precioOverride && precioOverride > 0 ? precioOverride : prod.precio;
      await c.query(
        `update ${S}.mesa_sesion_items
            set producto_id=$1, producto_nombre=$2, precio_unitario=$3, total=$4,
                es_mitad_mitad=$5, mitad_1_producto_id=null, mitad_2_producto_id=null,
                mitad_1_nombre=$6, mitad_2_nombre=$7, item_display_name=$8
          where id=$9 and empresa_id=$10`,
        [prod.id, displayName || prod.nombre, precio, Math.round(precio * cur.cantidad),
         !!mitad, mitad?.n1 ?? null, mitad?.n2 ?? null, displayName, itemId, empresaId]
      );
      return { ok: true };
    }

    const total = async () =>
      Number(
        (await c.query(
          `select coalesce(sum(total),0)::float8 t from ${S}.mesa_sesion_items
            where sesion_id=$1 and estado <> 'cancelado'`, [sesionId])).rows[0].t
      );

    // ── Caso del pedido: 2 pizzas del sabor equivocado ───────────────────
    const itemId = await agregar(barata, 2);
    const totalAntes = await total();
    if (totalAntes !== Math.round(barata.precio) * 2)
      fallar(`total inicial ${totalAntes}, se esperaba ${Math.round(barata.precio) * 2}`);

    await cambiarProducto(itemId, cara);
    const fila = (
      await c.query(
        `select producto_id, producto_nombre, cantidad::float8 cantidad,
                precio_unitario::float8 precio, total::float8 total, es_mitad_mitad
           from ${S}.mesa_sesion_items where id=$1`, [itemId])
    ).rows[0];
    console.table([fila]);

    if (fila.producto_id !== cara.id) fallar("no cambió el producto");
    if (fila.cantidad !== 2) fallar(`se perdió la cantidad: ${fila.cantidad}`);
    if (fila.precio !== cara.precio) fallar(`el precio quedó en ${fila.precio}, se esperaba ${cara.precio}`);
    if (fila.total !== Math.round(cara.precio * 2))
      fallar(`el total quedó en ${fila.total}, se esperaba ${Math.round(cara.precio * 2)}`);
    if ((await total()) !== Math.round(cara.precio * 2)) fallar("el total de la mesa no se actualizó");

    // ── De mitad y mitad a producto normal: hay que limpiar los sabores ──
    const mitadId = await agregar(
      cara, 1, { n1: barata.nombre, n2: cara.nombre }, `½ ${barata.nombre} + ½ ${cara.nombre}`, cara.precio
    );
    await cambiarProducto(mitadId, barata);
    const f2 = (
      await c.query(
        `select es_mitad_mitad, mitad_1_nombre, mitad_2_nombre, item_display_name,
                producto_nombre, total::float8 total
           from ${S}.mesa_sesion_items where id=$1`, [mitadId])
    ).rows[0];
    console.table([f2]);
    if (f2.es_mitad_mitad) fallar("siguió marcada como mitad y mitad");
    if (f2.mitad_1_nombre || f2.mitad_2_nombre)
      fallar("quedaron los sabores viejos: la comanda anunciaría una pizza que no es");
    if (f2.item_display_name) fallar("quedó el nombre a mostrar de la mitad y mitad");
    if (f2.total !== Math.round(barata.precio)) fallar(`total ${f2.total}, se esperaba ${Math.round(barata.precio)}`);

    // ── Una línea ya enviada a cocina no se edita ────────────────────────
    const enviadoId = await agregar(barata, 1);
    await c.query(`update ${S}.mesa_sesion_items set estado='enviado' where id=$1`, [enviadoId]);
    const r = await cambiarProducto(enviadoId, cara);
    if (!r.error) fallar("dejó cambiar un producto ya enviado a cocina");
    else console.log(`Enviado a cocina: bloqueado — "${r.error}"`);

    console.log(`\n${fallos === 0 ? "EDITAR PEDIDO DE MESA OK" : `${fallos} FALLO(S)`}`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
