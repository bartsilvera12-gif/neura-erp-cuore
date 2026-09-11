/**
 * Prueba en transacción con ROLLBACK del pedido que sigue vivo después de
 * enviarlo a cocina.
 *
 * Recorre el caso completo: el mozo manda la comanda, el cliente agrega algo,
 * el mozo corrige un sabor mal cargado y cancela otra cosa. Verifica que el
 * agregado salga solo (sin reimprimir lo anterior), que cocina reciba los
 * avisos de MODIFICACIÓN y CANCELACIÓN en el sector correcto, y que quede
 * historial de quién tocó qué.
 *
 * No deja nada en la base.
 */
const { Client } = require("pg");
const { randomUUID } = require("crypto");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  const pizzas = (
    await c.query(
      `select id, nombre, precio_venta::float8 precio from ${S}.productos
        where empresa_id=$1 and sector_produccion='pizzeria' and precio_venta > 0
        order by nombre limit 2`, [empresaId])
  ).rows;
  const bebida = (
    await c.query(
      `select id, nombre, precio_venta::float8 precio from ${S}.productos
        where empresa_id=$1 and sector_produccion='ninguno' and precio_venta > 0
        order by nombre limit 1`, [empresaId])
  ).rows[0];
  if (pizzas.length < 2 || !bebida) throw new Error("Faltan productos para la prueba.");

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    const mesaId = (await c.query(
      `insert into ${S}.mesas (empresa_id, numero, estado) values ($1, 9998, 'ocupada') returning id`,
      [empresaId])).rows[0].id;
    const sesionId = (await c.query(
      `insert into ${S}.mesa_sesiones (empresa_id, mesa_id, tipo, estado)
       values ($1,$2,'mesa','abierta') returning id`, [empresaId, mesaId])).rows[0].id;

    const agregar = async (prod, cantidad) => (await c.query(
      `insert into ${S}.mesa_sesion_items
         (empresa_id, sesion_id, producto_id, producto_nombre, sku, cantidad,
          precio_unitario, total, estado)
       values ($1,$2,$3,$4,'',$5,$6,$7,'pendiente') returning id`,
      [empresaId, sesionId, prod.id, prod.nombre, cantidad, prod.precio,
       Math.round(prod.precio * cantidad)])).rows[0].id;

    const proximoNumero = async () => Number((await c.query(
      `select coalesce(max(numero),0) n from ${S}.comandas where empresa_id=$1 and sesion_id=$2`,
      [empresaId, sesionId])).rows[0].n) + 1;

    /** Envía a cocina sólo lo pendiente, como enviarProduccionDeSesion. */
    async function enviar() {
      const pend = (await c.query(
        `select id from ${S}.mesa_sesion_items
          where empresa_id=$1 and sesion_id=$2 and estado='pendiente'`,
        [empresaId, sesionId])).rows;
      if (pend.length === 0) return { comandaId: null, enviados: 0 };
      const previas = (await c.query(
        `select id from ${S}.comandas where empresa_id=$1 and sesion_id=$2 limit 1`,
        [empresaId, sesionId])).rows.length > 0;
      const batchId = randomUUID();
      const comandaId = (await c.query(
        `insert into ${S}.comandas (empresa_id, sesion_id, numero, sector, batch_id, es_agregado)
         values ($1,$2,$3,'pizzeria',$4,$5) returning id`,
        [empresaId, sesionId, await proximoNumero(), batchId, previas])).rows[0].id;
      await c.query(
        `update ${S}.mesa_sesion_items
            set estado='enviado', comanda_id=$1, enviado_at=now(), produccion_batch_id=$2
          where empresa_id=$3 and sesion_id=$4 and estado='pendiente'`,
        [comandaId, batchId, empresaId, sesionId]);
      return { comandaId, enviados: pend.length, esAgregado: previas };
    }

    async function avisar(tipo, lineas) {
      await c.query(
        `insert into ${S}.comandas (empresa_id, sesion_id, numero, sector, tipo, detalle)
         values ($1,$2,$3,'pizzeria',$4,$5::jsonb)`,
        [empresaId, sesionId, await proximoNumero(), tipo, JSON.stringify({ lineas })]);
    }
    async function historial(itemId, accion, descripcion, yaEnviado) {
      await c.query(
        `insert into ${S}.mesa_sesion_item_historial
           (empresa_id, sesion_id, item_id, accion, descripcion, ya_enviado, usuario_nombre)
         values ($1,$2,$3,$4,$5,$6,'mozo@lacaribena')`,
        [empresaId, sesionId, itemId, accion, descripcion, yaEnviado]);
    }

    // ── 1. Pedido original y envío ────────────────────────────────────────
    const itemPizza = await agregar(pizzas[0], 2);
    await historial(itemPizza, "agregado", `Agregó 2× ${pizzas[0].nombre}`, false);
    const env1 = await enviar();
    if (env1.enviados !== 1) fallar(`el primer envío mandó ${env1.enviados} líneas`);
    if (env1.esAgregado) fallar("la primera comanda se marcó como agregado");

    // ── 2. El cliente agrega una bebida: sale sola ────────────────────────
    const itemBebida = await agregar(bebida, 1);
    await historial(itemBebida, "agregado", `Agregó 1× ${bebida.nombre}`, false);
    const env2 = await enviar();
    if (env2.enviados !== 1)
      fallar(`el agregado mandó ${env2.enviados} líneas: tenía que mandar sólo la nueva`);
    if (!env2.esAgregado) fallar("la segunda comanda no se marcó como agregado");

    // ── 3. Sabor equivocado: se corrige lo ya enviado ─────────────────────
    await c.query(
      `update ${S}.mesa_sesion_items
          set producto_id=$1, producto_nombre=$2, precio_unitario=$3, total=$4
        where id=$5`,
      [pizzas[1].id, pizzas[1].nombre, pizzas[1].precio, Math.round(pizzas[1].precio * 2), itemPizza]);
    await avisar("modificacion", [{ antes: `2× ${pizzas[0].nombre}`, ahora: `2× ${pizzas[1].nombre}` }]);
    await historial(itemPizza, "producto", `Cambió ${pizzas[0].nombre} por ${pizzas[1].nombre}`, true);

    // ── 4. Se cancela la bebida ya enviada ────────────────────────────────
    await c.query(`update ${S}.mesa_sesion_items set estado='cancelado' where id=$1`, [itemBebida]);
    await avisar("cancelacion", [{ antes: `1× ${bebida.nombre}` }]);
    await historial(itemBebida, "cancelado", `Canceló 1× ${bebida.nombre}`, true);

    // ── Verificaciones ────────────────────────────────────────────────────
    const comandas = (await c.query(
      `select numero, tipo, es_agregado, detalle from ${S}.comandas
        where empresa_id=$1 and sesion_id=$2 order by numero`, [empresaId, sesionId])).rows;
    console.table(comandas.map((x) => ({
      numero: x.numero, tipo: x.tipo, agregado: x.es_agregado,
      detalle: x.detalle ? JSON.stringify(x.detalle.lineas) : "",
    })));

    if (comandas.length !== 4) fallar(`se esperaban 4 comandas y hay ${comandas.length}`);
    if (comandas[0].tipo !== "pedido" || comandas[0].es_agregado)
      fallar("la primera tenía que ser un pedido normal");
    if (comandas[1].tipo !== "pedido" || !comandas[1].es_agregado)
      fallar("la segunda tenía que ser un pedido marcado como agregado");
    if (comandas[2].tipo !== "modificacion") fallar("falta el aviso de modificación");
    if (comandas[3].tipo !== "cancelacion") fallar("falta el aviso de cancelación");
    if (!comandas[2].detalle?.lineas?.[0]?.ahora)
      fallar("el aviso de modificación no dice qué hay ahora");

    // El total de la mesa refleja la corrección y descuenta lo cancelado.
    const total = Number((await c.query(
      `select coalesce(sum(total),0)::float8 t from ${S}.mesa_sesion_items
        where sesion_id=$1 and estado <> 'cancelado'`, [sesionId])).rows[0].t);
    const esperado = Math.round(pizzas[1].precio * 2);
    if (total !== esperado) fallar(`total ${total}, se esperaba ${esperado}`);

    const hist = (await c.query(
      `select accion, descripcion, ya_enviado, usuario_nombre from ${S}.mesa_sesion_item_historial
        where sesion_id=$1 order by created_at`, [sesionId])).rows;
    console.table(hist);
    if (hist.length !== 4) fallar(`el historial tiene ${hist.length} renglones y se esperaban 4`);
    if (!hist.every((h) => h.usuario_nombre)) fallar("hay renglones de historial sin usuario");
    if (hist.filter((h) => h.ya_enviado).length !== 2)
      fallar("no se distinguen los cambios hechos sobre algo ya enviado");

    console.log(`\n${fallos === 0 ? "MODIFICACIÓN DE COMANDA OK" : `${fallos} FALLO(S)`}`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
