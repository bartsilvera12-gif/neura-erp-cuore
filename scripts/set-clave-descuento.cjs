/**
 * Carga o cambia la clave que autoriza descuentos en el cobro.
 *
 * La clave se guarda hasheada con bcrypt y nunca en claro: quien lea la base no
 * puede aplicar descuentos. Se toma de una variable de entorno para que no
 * quede escrita en el historial de la terminal.
 *
 *   CLAVE_DESCUENTO='loquesea' node scripts/set-clave-descuento.cjs
 *
 * Opcional, tope de descuento permitido (por defecto 100 %):
 *
 *   CLAVE_DESCUENTO='loquesea' MAX_PORCENTAJE=30 node scripts/set-clave-descuento.cjs
 *
 * Correrlo de nuevo reemplaza la clave anterior.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const CLAVE = process.env.CLAVE_DESCUENTO || "";
const MAX = Number(process.env.MAX_PORCENTAJE || 100);

if (!CLAVE) {
  console.error("Falta CLAVE_DESCUENTO en el entorno.");
  console.error("Ejemplo: CLAVE_DESCUENTO='...' node scripts/set-clave-descuento.cjs");
  process.exit(1);
}
if (CLAVE.length < 4) {
  console.error("La clave es demasiado corta: usá al menos 4 caracteres.");
  process.exit(1);
}
if (!(MAX > 0 && MAX <= 100)) {
  console.error("MAX_PORCENTAJE tiene que estar entre 1 y 100.");
  process.exit(1);
}

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  try {
    const empresaId = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;

    await c.query(
      `INSERT INTO ${S}.empresa_descuento_config (empresa_id, clave_hash, max_porcentaje, actualizado_at)
       VALUES ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3, now())
       ON CONFLICT (empresa_id) DO UPDATE
         SET clave_hash = EXCLUDED.clave_hash,
             max_porcentaje = EXCLUDED.max_porcentaje,
             actualizado_at = now()`,
      [empresaId, CLAVE, MAX]
    );

    // Se comprueba que la clave guardada valide, para no dejar a la caja con una
    // clave que no funciona.
    const { rows } = await c.query(
      `SELECT clave_hash = extensions.crypt($2, clave_hash) AS ok, max_porcentaje
         FROM ${S}.empresa_descuento_config WHERE empresa_id = $1`,
      [empresaId, CLAVE]
    );
    if (rows[0]?.ok !== true) {
      console.error("La clave se guardó pero no valida. No la uses todavía.");
      process.exit(1);
    }

    console.log("Clave de descuentos cargada y verificada.");
    console.log(`Tope de descuento: ${rows[0].max_porcentaje}%`);
    console.log("La clave no queda escrita en ningún lado en claro.");
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
