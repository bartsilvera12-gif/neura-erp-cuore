/**
 * Prueba en transacción con ROLLBACK: inserta una venta por cada camino de
 * entrada y verifica que el reporte la clasifique en la modalidad correcta.
 * No deja nada en la base.
 */
const { Client } = require("pg");
const c = new Client({ connectionString: "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable" });
const S = "caribenaerp";

const MOD = `COALESCE(
  (SELECT ms.tipo FROM ${S}.mesa_sesiones ms WHERE ms.empresa_id = ve.empresa_id AND ms.venta_id = ve.id LIMIT 1),
  (SELECT pr.metadata->>'modalidad' FROM ${S}.proyectos pr WHERE pr.empresa_id = ve.empresa_id AND pr.metadata->>'venta_id' = ve.id::text LIMIT 1),
  'sin_dato')`;
const REF = `COALESCE(
  NULLIF(ve.observaciones, ''),
  (SELECT NULLIF(pr.brief_data->>'cliente_nombre','') FROM ${S}.proyectos pr WHERE pr.empresa_id = ve.empresa_id AND pr.metadata->>'venta_id' = ve.id::text LIMIT 1),
  (SELECT ms.nombre_cliente FROM ${S}.mesa_sesiones ms WHERE ms.empresa_id = ve.empresa_id AND ms.venta_id = ve.id LIMIT 1))`;

(async () => {
  await c.connect();
  const emp = (await c.query(`select id from ${S}.empresas limit 1`)).rows[0].id;
  const tipoId = (await c.query(`select id from ${S}.proyecto_tipos limit 1`)).rows[0].id;
  const estadoId = (await c.query(`select id from ${S}.proyecto_estados limit 1`)).rows[0].id;
  const mesaId = (await c.query(`select id from ${S}.mesas limit 1`)).rows[0].id;

  await c.query("BEGIN");
  try {
    const venta = async (numero, observaciones) =>
      (await c.query(
        `insert into ${S}.ventas (empresa_id, numero_control, subtotal, monto_iva, total, observaciones, metodo_pago, fecha)
         values ($1,$2,90909,9091,100000,$3,'efectivo', now()) returning id`,
        [emp, numero, observaciones]
      )).rows[0].id;

    const sesion = async (ventaId, tipo, mesa, nombre, numeroPl) =>
      c.query(
        `insert into ${S}.mesa_sesiones (empresa_id, mesa_id, tipo, estado, venta_id, nombre_cliente, numero_pl)
         values ($1,$2,$3,'facturada',$4,$5,$6)`,
        [emp, mesa, tipo, ventaId, nombre, numeroPl]
      );

    const proyecto = async (ventaId, modalidad, clienteNombre) =>
      c.query(
        `insert into ${S}.proyectos (empresa_id, tipo_id, estado_id, titulo, prioridad, fecha_ingreso, brief_data, metadata)
         values ($1,$2,$3,$4,'normal', now(), $5::jsonb, $6::jsonb)`,
        [emp, tipoId, estadoId, `Venta test ${modalidad}`,
         JSON.stringify({ modalidad, cliente_nombre: clienteNombre }),
         JSON.stringify({ source: "venta", venta_id: ventaId, modalidad })]
      );

    const vMesa = await venta("TEST-MESA", "Mesa 1");
    await sesion(vMesa, "mesa", mesaId, null, null);

    const vPl = await venta("TEST-PL", "Para llevar PL-001 · Ana");
    await sesion(vPl, "para_llevar", null, "Ana", 9991);

    const vDel = await venta("TEST-DELIVERY", null);
    await proyecto(vDel, "delivery", "Juan Pérez");

    const vLocal = await venta("TEST-LOCAL", null);
    await proyecto(vLocal, "local", null);

    const vRetiro = await venta("TEST-RETIRO", null);
    await proyecto(vRetiro, "carry_out", "Marta");

    await venta("TEST-HUERFANA", null); // sin mesa ni pedido

    const where = `WHERE ve.empresa_id = $1::uuid AND ve.estado <> 'anulada'`;
    const porMod = await c.query(
      `SELECT ${MOD} AS modalidad, COUNT(*)::int ventas, SUM(ve.total)::int total
         FROM ${S}.ventas ve ${where} GROUP BY 1 ORDER BY 1`, [emp]);
    console.table(porMod.rows);

    const det = await c.query(
      `SELECT ve.numero_control, ${MOD} AS modalidad, ${REF} AS referencia
         FROM ${S}.ventas ve ${where} ORDER BY ve.numero_control`, [emp]);
    console.table(det.rows);

    const esperado = {
      "TEST-MESA": "mesa",
      "TEST-PL": "para_llevar",
      "TEST-DELIVERY": "delivery",
      "TEST-LOCAL": "local",
      "TEST-RETIRO": "carry_out",
      "TEST-HUERFANA": "sin_dato",
    };
    let fallos = 0;
    for (const row of det.rows) {
      const ok = esperado[row.numero_control] === row.modalidad;
      if (!ok) { fallos++; console.log(`FALLO ${row.numero_control}: esperaba ${esperado[row.numero_control]}, dio ${row.modalidad}`); }
    }
    const total = await c.query(`SELECT COUNT(*)::int n, SUM(ve.total)::int t FROM ${S}.ventas ve ${where}`, [emp]);
    console.log(`\nSuma sin duplicar: ${total.rows[0].n} ventas / ${total.rows[0].t} (esperado 6 / 600000)`);
    console.log(fallos === 0 ? "TODAS LAS MODALIDADES OK" : `${fallos} FALLO(S)`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
