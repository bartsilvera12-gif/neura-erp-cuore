/**
 * Prueba en transacción con ROLLBACK de que el día de una venta es el día en
 * Paraguay y no el día UTC.
 *
 * Hay dos defectos distintos en juego:
 *
 *   1. Leer la fecha sin convertir devuelve el día UTC. Una venta de las 21:06
 *      de Paraguay ocurre a las 00:06 UTC del día siguiente, así que toda la
 *      cena se contaba como del día de mañana.
 *
 *   2. Convertir con el nombre 'America/Asuncion' tampoco alcanza: el Postgres
 *      de producción tiene la base de zonas horarias vieja y sigue aplicando el
 *      horario de verano que Paraguay derogó en 2024. Entre abril y septiembre
 *      responde UTC-4 en vez de UTC-3, y una venta de las 00:30 queda fechada
 *      el día anterior.
 *
 * Por eso se usa el desplazamiento fijo -03:00, que no depende de qué tan al
 * día esté el servidor.
 *
 * No deja nada en la base.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const OFF = "-03:00";

/** Cada caso: un instante UTC y el día paraguayo que le corresponde de verdad. */
const CASOS = [
  {
    nombre: "cena: 21:06 del viernes en Paraguay",
    instante: "2026-08-29T00:06:04Z",
    diaEsperado: "2026-08-28",
    rompe: "UTC",
  },
  {
    nombre: "cierre: 00:30 del sábado en Paraguay",
    instante: "2026-08-29T03:30:00Z",
    diaEsperado: "2026-08-29",
    rompe: "el nombre de la zona (tzdata viejo)",
  },
];

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("  FALLO: " + m); };

    for (const caso of CASOS) {
      console.log(`\n${caso.nombre}  (rompía con ${caso.rompe})`);

      const ventaId = (await c.query(
        `insert into ${S}.ventas (empresa_id, numero_control, subtotal, monto_iva, total, fecha)
         values ($1,'VTA-QA-TZ',22727,2273,25000,$2::timestamptz) returning id`,
        [empresaId, caso.instante]
      )).rows[0].id;

      const q = await c.query(
        `select to_char(fecha, 'YYYY-MM-DD')                                as dia_utc,
                to_char(fecha at time zone 'America/Asuncion','YYYY-MM-DD') as dia_por_nombre,
                to_char(fecha at time zone interval '${OFF}','YYYY-MM-DD')  as dia_fijo
           from ${S}.ventas where id = $1`,
        [ventaId]
      );
      const r = q.rows[0];
      const marca = (v) => (v === caso.diaEsperado ? "" : "   ← mal");
      console.log(`  en UTC                 → ${r.dia_utc}${marca(r.dia_utc)}`);
      console.log(`  con 'America/Asuncion' → ${r.dia_por_nombre}${marca(r.dia_por_nombre)}`);
      console.log(`  con -03:00 fijo        → ${r.dia_fijo}${marca(r.dia_fijo)}`);

      if (r.dia_fijo !== caso.diaEsperado) {
        fallar(`el día dio ${r.dia_fijo} y tenía que dar ${caso.diaEsperado}`);
      }

      // El filtro por rango tiene que traer la venta al pedir ese día.
      const filtro = await c.query(
        `select count(*)::int as n from ${S}.ventas
          where id = $1
            and fecha >= ($2::timestamp at time zone interval '${OFF}')
            and fecha <  (($2::timestamp + interval '1 day') at time zone interval '${OFF}')`,
        [ventaId, caso.diaEsperado]
      );
      if (filtro.rows[0].n !== 1) {
        fallar(`filtrando por el ${caso.diaEsperado} la venta no aparece`);
      } else {
        console.log(`  filtro por ${caso.diaEsperado}: la trae.`);
      }
    }

    console.log(`\n${fallos === 0 ? "FECHA EN HORA DE PARAGUAY OK" : `${fallos} FALLO(S)`}`);
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
