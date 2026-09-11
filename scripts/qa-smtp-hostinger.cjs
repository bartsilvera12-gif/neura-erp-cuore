/**
 * Comprueba que la casilla del remitente pueda conectarse y autenticarse
 * contra el servidor SMTP, antes de cargar nada en el servidor.
 *
 * Sólo verifica la conexión y el login: no manda ningún correo, salvo que se
 * pase --a=alguien@dominio, en cuyo caso manda una prueba a esa dirección.
 *
 * La contraseña se toma de SMTP_PASSWORD; nunca se escribe en el repo.
 *
 *   SMTP_PASSWORD=... node scripts/qa-smtp-hostinger.cjs
 *   SMTP_PASSWORD=... node scripts/qa-smtp-hostinger.cjs --a=karen@ejemplo.com
 */
const nodemailer = require("nodemailer");

const HOST = process.env.SMTP_HOST || "smtp.hostinger.com";
const USER = process.env.SMTP_USER || "info@neura.com.py";
const PASS = process.env.SMTP_PASSWORD || "";
const destino = (process.argv.find((a) => a.startsWith("--a=")) || "").slice(4);

if (!PASS) {
  console.error("Falta SMTP_PASSWORD en el entorno.");
  process.exit(1);
}

/** Se prueban los dos puertos: el que ande es el que va en la configuración. */
const PUERTOS = [
  { port: 465, secure: true },
  { port: 587, secure: false },
];

(async () => {
  let anduvo = null;
  for (const p of PUERTOS) {
    const t = nodemailer.createTransport({
      host: HOST,
      port: p.port,
      secure: p.secure,
      auth: { user: USER, pass: PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    });
    try {
      await t.verify();
      console.log(`OK  puerto ${p.port} (secure=${p.secure}): conecta y autentica.`);
      if (!anduvo) anduvo = p;
    } catch (e) {
      console.log(`--  puerto ${p.port}: ${e.message}`);
    } finally {
      t.close();
    }
  }

  if (!anduvo) {
    console.log("\nNingún puerto funcionó. Revisá usuario, contraseña o el host.");
    process.exit(1);
  }

  console.log(`\nUsar SMTP_PORT=${anduvo.port}`);

  if (destino) {
    const t = nodemailer.createTransport({
      host: HOST,
      port: anduvo.port,
      secure: anduvo.secure,
      auth: { user: USER, pass: PASS },
    });
    const info = await t.sendMail({
      from: USER,
      to: destino,
      subject: "Prueba de envío — Neura ERP",
      text: "Si recibiste esto, el envío de facturas por correo va a funcionar.",
    });
    console.log(`Correo de prueba mandado a ${destino} (${info.messageId}).`);
    t.close();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
