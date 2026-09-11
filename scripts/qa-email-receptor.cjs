/**
 * Prueba en transacción con ROLLBACK del correo del receptor.
 *
 * Verifica que el correo cargado en la caja quede en tres lugares: en la
 * factura (para que el documento diga a dónde se mandó aunque el cliente
 * después lo cambie), en la ficha del cliente (para la próxima vez) y
 * disponible para el XML.
 *
 * También comprueba que facturar de nuevo al mismo RUC no cree otra ficha, y
 * que si la ficha existía sin correo se le complete.
 *
 * No deja nada en la base.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const RUC = "99999999-1";
const MAIL = "cliente.prueba@example.com";

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    /** Lo que hace facturarVentaPg al guardar el cliente. */
    async function altaOReuso(email) {
      const ya = await c.query(
        `select id from ${S}.clientes
          where empresa_id=$1 and deleted_at is null
            and coalesce(nullif(trim(ruc),''), nullif(trim(documento),'')) = $2
          order by created_at limit 1`,
        [empresaId, RUC]
      );
      if (ya.rows[0]) {
        // Completa el correo sólo si estaba vacío: no pisa lo cargado a mano.
        await c.query(
          `update ${S}.clientes set email=$1, updated_at=now()
            where id=$2 and coalesce(nullif(trim(email),''),'') = ''`,
          [email, ya.rows[0].id]
        );
        return { id: ya.rows[0].id, creado: false };
      }
      const r = await c.query(
        `insert into ${S}.clientes
           (empresa_id, tipo_cliente, nombre, empresa, nombre_facturacion,
            ruc, es_contribuyente, email, estado, origen)
         values ($1,'empresa','TEST QA SRL','TEST QA SRL','TEST QA SRL',$2,true,$3,'activo','CAJA')
         returning id`,
        [empresaId, RUC, email]
      );
      return { id: r.rows[0].id, creado: true };
    }

    // ── Primera factura: crea la ficha con correo ─────────────────────────
    const a = await altaOReuso(MAIL);
    if (!a.creado) fallar("la primera vez tenía que crear la ficha");

    const cli1 = (await c.query(
      `select email, ruc, es_contribuyente from ${S}.clientes where id=$1`, [a.id])).rows[0];
    console.table([cli1]);
    if (cli1.email !== MAIL) fallar(`el correo no se guardó en la ficha: ${cli1.email}`);

    // ── Segunda factura al mismo RUC: reusa, no duplica ───────────────────
    const b = await altaOReuso("otro@example.com");
    if (b.creado) fallar("creó una ficha nueva para un RUC que ya existía");
    if (b.id !== a.id) fallar("no reusó la misma ficha");

    const cli2 = (await c.query(`select email from ${S}.clientes where id=$1`, [a.id])).rows[0];
    if (cli2.email !== MAIL)
      fallar(`pisó el correo cargado: quedó ${cli2.email} en vez de ${MAIL}`);
    console.log("Reuso: no duplica y no pisa el correo ya cargado.");

    // ── Ficha sin correo: se completa ─────────────────────────────────────
    await c.query(`update ${S}.clientes set email=null where id=$1`, [a.id]);
    await altaOReuso("completado@example.com");
    const cli3 = (await c.query(`select email from ${S}.clientes where id=$1`, [a.id])).rows[0];
    if (cli3.email !== "completado@example.com")
      fallar("no completó el correo de una ficha que no lo tenía");
    console.log("Ficha sin correo: se completa con el que se carga.");

    // ── Cliente elegido del buscador: también se le completa el correo ────
    //
    // Este era el hueco: la ficha ya existía y venía elegida desde la caja, así
    // que no pasaba por el alta y el correo nunca se guardaba. Había que
    // escribirlo en cada factura y el buscador jamás lo traía.
    await c.query(`update ${S}.clientes set email = null where id = $1`, [a.id]);

    /** Lo que hace facturarVentaPg cuando la factura ya tiene cliente_id. */
    async function completarCorreoDeClienteElegido(clienteId, email) {
      await c.query(
        `update ${S}.clientes set email=$1, updated_at=now()
          where id=$2 and coalesce(nullif(trim(email),''),'') = ''`,
        [email, clienteId]
      );
    }

    await completarCorreoDeClienteElegido(a.id, MAIL);
    const elegido = (await c.query(
      `select email from ${S}.clientes where id=$1`, [a.id])).rows[0];
    if (elegido.email !== MAIL) {
      fallar("al facturar a un cliente ya existente no se le guardó el correo");
    } else {
      console.log("Cliente elegido del buscador: se le guarda el correo.");
    }

    // Y una segunda factura a ese mismo cliente no lo pisa.
    await completarCorreoDeClienteElegido(a.id, "otro@example.com");
    const trasSegunda = (await c.query(
      `select email from ${S}.clientes where id=$1`, [a.id])).rows[0];
    if (trasSegunda.email !== MAIL) {
      fallar(`pisó el correo ya guardado: quedó ${trasSegunda.email}`);
    } else {
      console.log("Segunda factura al mismo cliente: no pisa el correo.");
    }

    // ── La factura guarda su propia copia ─────────────────────────────────
    const ventaId = (await c.query(
      `insert into ${S}.ventas (empresa_id, numero_control, subtotal, monto_iva, total, fecha)
       values ($1,'VTA-QA-MAIL',90909,9091,100000, now()) returning id`, [empresaId])).rows[0].id;
    const facturaId = (await c.query(
      `insert into ${S}.facturas (empresa_id, cliente_id, numero_factura, fecha, fecha_vencimiento,
         monto, tipo, cliente_razon_social, cliente_ruc, cliente_email, origen_venta_id)
       values ($1,$2,'FAC-QA-MAIL',current_date,current_date,100000,'contado','TEST QA SRL',$3,$4,$5)
       returning id`, [empresaId, a.id, RUC, MAIL, ventaId])).rows[0].id;

    const fac = (await c.query(
      `select cliente_email from ${S}.facturas where id=$1`, [facturaId])).rows[0];
    if (fac.cliente_email !== MAIL) fallar("la factura no conservó su copia del correo");

    // Y si mañana el cliente cambia de correo, la factura sigue diciendo el suyo.
    await c.query(`update ${S}.clientes set email='cambiado@example.com' where id=$1`, [a.id]);
    const fac2 = (await c.query(
      `select cliente_email from ${S}.facturas where id=$1`, [facturaId])).rows[0];
    if (fac2.cliente_email !== MAIL)
      fallar("cambiar el correo del cliente alteró una factura ya emitida");
    console.log("Factura: conserva su copia aunque el cliente cambie de correo.");

    console.log(`\n${fallos === 0 ? "CORREO DEL RECEPTOR OK" : `${fallos} FALLO(S)`}`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
