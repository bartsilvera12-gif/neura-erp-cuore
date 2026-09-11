/**
 * Prueba en transacción con ROLLBACK de que el arqueo cierra con ventas por QR.
 *
 * El QR se cobra como cualquier otro medio electrónico, pero quedaba fuera del
 * total esperado del cierre. Una venta por QR de Gs. 50.000 hacía que el turno
 * cerrara con 50.000 de diferencia: plata que estaba, pero que el cierre no
 * contaba. El cajero la busca en el cajón y no la encuentra, porque nunca pasó
 * por ahí.
 *
 * Se arma un turno con las cuatro formas de pago y se comprueba que:
 *   · el efectivo esperado sólo incluya el efectivo (el QR no está en el cajón);
 *   · el cierre total esperado incluya el QR;
 *   · contando bien el efectivo, la diferencia del turno dé cero.
 *
 * No deja nada en la base.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";

const APERTURA = 100_000;
const VENTAS = [
  { metodo: "efectivo", monto: 30_000 },
  { metodo: "transferencia", monto: 20_000 },
  { metodo: "tarjeta", monto: 15_000 },
  { metodo: "qr", monto: 50_000 },
];

const gs = (n) => `Gs. ${Math.round(n).toLocaleString("es-PY")}`;

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    const cajaId = (await c.query(
      `insert into ${S}.cajas (empresa_id, numero_caja, estado, monto_apertura, fecha_apertura)
       values ($1, 999, 'abierta', $2, now()) returning id`,
      [empresaId, APERTURA]
    )).rows[0].id;

    for (const [i, v] of VENTAS.entries()) {
      await c.query(
        `insert into ${S}.ventas (empresa_id, caja_id, numero_control, subtotal, monto_iva, total, metodo_pago, fecha)
         values ($1,$2,$3,$4,$5,$6,$7, now())`,
        [empresaId, cajaId, `VTA-QA-QR-${i}`, Math.round(v.monto / 1.1), v.monto - Math.round(v.monto / 1.1), v.monto, v.metodo]
      );
    }

    const { rows } = await c.query(
      `select metodo_pago, sum(total)::bigint as total
         from ${S}.ventas where caja_id = $1 group by 1`,
      [cajaId]
    );
    const por = Object.fromEntries(rows.map((r) => [r.metodo_pago, Number(r.total)]));
    const efectivo = por.efectivo ?? 0;
    const transf = por.transferencia ?? 0;
    const tarjeta = por.tarjeta ?? 0;
    const qr = por.qr ?? 0;

    // Lo que el cajero tiene que encontrar físicamente en el cajón.
    const efectivoEsperado = APERTURA + efectivo;
    // Lo que movió el turno entero, sin importar por dónde entró.
    const cierreTotalEsperado = efectivoEsperado + transf + tarjeta + qr;

    console.log(`Apertura ${gs(APERTURA)}`);
    console.log(`Ventas: efectivo ${gs(efectivo)} · transferencia ${gs(transf)} · tarjeta ${gs(tarjeta)} · QR ${gs(qr)}`);
    console.log(`Efectivo esperado en el cajón: ${gs(efectivoEsperado)}`);
    console.log(`Cierre total esperado:         ${gs(cierreTotalEsperado)}`);

    if (efectivoEsperado !== APERTURA + 30_000) {
      fallar(`el QR se coló en el efectivo esperado: dio ${gs(efectivoEsperado)}`);
    }
    if (cierreTotalEsperado !== APERTURA + 115_000) {
      fallar(`el cierre total no incluye todo: dio ${gs(cierreTotalEsperado)}`);
    }

    // El cajero cuenta bien el efectivo: el turno tiene que cerrar en cero.
    const contado = efectivoEsperado;
    const totalDeclarado = contado + transf + tarjeta + qr;
    const difTotal = totalDeclarado - cierreTotalEsperado;
    console.log(`\nContando ${gs(contado)} de efectivo, la diferencia del turno da ${gs(difTotal)}.`);
    if (difTotal !== 0) fallar(`la diferencia tenía que dar 0 y dio ${gs(difTotal)}`);

    // Y así se veía antes, sin contar el QR: una diferencia inventada.
    const viejo = (contado + transf + tarjeta) - (efectivoEsperado + transf + tarjeta);
    const viejoTotalEsperado = efectivoEsperado + transf + tarjeta;
    console.log(
      `Con el cálculo viejo el cierre esperado era ${gs(viejoTotalEsperado)}: ` +
        `${gs(qr)} de ventas por QR quedaban afuera del turno.`
    );
    if (viejo !== 0) fallar("la comprobación del cálculo viejo está mal armada");

    console.log(`\n${fallos === 0 ? "ARQUEO CON QR OK" : `${fallos} FALLO(S)`}`);
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
