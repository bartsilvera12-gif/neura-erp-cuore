/**
 * Cambia el ID del CSC de la empresa.
 *
 * El hash del QR se calcula sobre la cadena de parámetros más el CSC, y esa
 * cadena incluye `IdCSC`. Si el ID no es el que la SET le asignó al CSC, el
 * hash no coincide y el documento se rechaza con "El hash del código QR
 * incluido el de la cadena de caracteres es inválido" — aunque el CSC esté
 * bien copiado.
 *
 * Marangatú entrega hasta dos CSC por emisor: el ID suele ser 0001, pero puede
 * ser 0002. El valor está en el portal, en la misma pantalla del CSC.
 *
 *   node scripts/config-sifen-id-csc.cjs 0002 --commit
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const S = "caribenaerp";
const COMMIT = process.argv.includes("--commit");
const NUEVO = process.argv.find((a) => /^\d{4}$/.test(a));

(async () => {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const actual = await c.query(
    `select ambiente, id_csc, length(coalesce(csc,'')) csc_largo from ${S}.empresa_sifen_config`
  );
  console.table(actual.rows);

  if (!NUEVO) {
    console.log("Pasá el ID nuevo de 4 dígitos. Ej: node scripts/config-sifen-id-csc.cjs 0002 --commit");
    await c.end();
    return;
  }

  await c.query("BEGIN");
  try {
    const r = await c.query(
      `update ${S}.empresa_sifen_config set id_csc = $1, updated_at = now() returning ambiente, id_csc`,
      [NUEVO]
    );
    console.table(r.rows);
    if (COMMIT) {
      await c.query("COMMIT");
      console.log("\nCOMMIT aplicado. Regenerá el XML y volvé a firmar para que el QR se recalcule.");
    } else {
      await c.query("ROLLBACK");
      console.log("\nDRY-RUN: nada se guardó. Volvé a correr con --commit.");
    }
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
