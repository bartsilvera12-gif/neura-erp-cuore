/**
 * Muestra los últimos envíos de facturas por correo.
 *
 * Sirve para responder "¿le llegó la factura al cliente?" sin depender de la
 * casilla del remitente, y para saber si un envío falló y por qué.
 *
 * Ojo con la lista vacía: no significa que los envíos anduvieron. Significa que
 * nunca se intentó — y la causa más común es que falten las variables SMTP en
 * el servidor, porque en ese caso el envío se corta antes de intentar.
 *
 * Sólo lee.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const LIMITE = Number(process.argv[2]) || 20;

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();

  const { rows } = await c.query(
    `SELECT f.numero_factura,
            e.destinatario,
            e.origen,
            e.ok,
            e.error,
            to_char(e.created_at AT TIME ZONE INTERVAL '-03:00', 'YYYY-MM-DD HH24:MI') AS cuando
       FROM ${S}.factura_email_envios e
       JOIN ${S}.facturas f ON f.id = e.factura_id
      ORDER BY e.created_at DESC
      LIMIT ${LIMITE}`
  );

  if (rows.length === 0) {
    console.log("No hay ningún intento de envío registrado.");
    console.log("Si esperabas ver alguno, lo más probable es que falten las");
    console.log("variables SMTP en el servidor: sin ellas el envío ni se intenta.");
  } else {
    for (const r of rows) {
      const estado = r.ok ? "enviada" : "FALLÓ";
      console.log(`${r.cuando}  ${r.numero_factura}  ${estado}  →  ${r.destinatario}  (${r.origen})`);
      if (r.error) console.log(`    ${r.error}`);
    }
  }

  // Facturas aprobadas con correo cargado y sin ningún envío: las que deberían
  // haber salido y no salieron.
  const { rows: pendientes } = await c.query(
    `SELECT f.numero_factura, f.cliente_email
       FROM ${S}.facturas f
       JOIN ${S}.factura_electronica fe ON fe.factura_id = f.id
      WHERE fe.estado_sifen = 'aprobado'
        AND COALESCE(NULLIF(TRIM(f.cliente_email), ''), '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM ${S}.factura_email_envios e
           WHERE e.factura_id = f.id AND e.ok
        )
      ORDER BY f.numero_factura`
  );

  if (pendientes.length > 0) {
    console.log(`\nAprobadas con correo cargado que todavía no salieron (${pendientes.length}):`);
    for (const p of pendientes) {
      console.log(`  ${p.numero_factura}  →  ${p.cliente_email}`);
    }
  }

  await c.end();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
