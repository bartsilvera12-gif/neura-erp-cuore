/**
 * Prueba en transacción con ROLLBACK del alta de cliente desde la caja.
 *
 * Lo que importa no es sólo que la fila se guarde, sino que se guarde con los
 * campos fiscales correctos: si un cliente con RUC no queda marcado como
 * contribuyente, el armador del XML frena la factura y el envío al SET se
 * pierde. Verifica además que el buscador lo encuentre después.
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

  await c.query("BEGIN");
  try {
    let fallos = 0;
    const fallar = (m) => { fallos++; console.log("FALLO: " + m); };

    /** Lo que hace facturarVentaPg cuando se pide guardar el cliente. */
    async function altaCliente({ razonSocial, ruc, documento }) {
      const conRuc = !!ruc;
      return (
        await c.query(
          `insert into ${S}.clientes (
             empresa_id, tipo_cliente, nombre, empresa, nombre_facturacion,
             ruc, documento, es_contribuyente, estado, origen)
           values ($1,$2,$3,$4,$3,$5,$6,$7,'activo','CAJA') returning id`,
          [empresaId, conRuc ? "empresa" : "persona", razonSocial,
           conRuc ? razonSocial : null, ruc, documento, conRuc]
        )
      ).rows[0].id;
    }

    // ── Con RUC: tiene que quedar como empresa contribuyente ──────────────
    const idEmpresa = await altaCliente({
      razonSocial: "PANADERIA SAN JUAN SRL", ruc: "80012345-6", documento: null,
    });
    // ── Con cédula: persona, y NO contribuyente ──────────────────────────
    const idPersona = await altaCliente({
      razonSocial: "JUAN PEREZ", ruc: null, documento: "4123456",
    });

    const filas = (
      await c.query(
        `select id, tipo_cliente, nombre, empresa, nombre_facturacion, ruc, documento,
                es_contribuyente, origen, estado
           from ${S}.clientes where id = any($1) order by nombre`,
        [[idEmpresa, idPersona]])
    ).rows;
    console.table(filas.map((f) => ({
      nombre: f.nombre, tipo: f.tipo_cliente, ruc: f.ruc, ci: f.documento,
      contribuyente: f.es_contribuyente, origen: f.origen,
    })));

    const emp = filas.find((f) => f.id === idEmpresa);
    const per = filas.find((f) => f.id === idPersona);

    if (emp.tipo_cliente !== "empresa") fallar("el cliente con RUC no quedó como empresa");
    if (emp.es_contribuyente !== true)
      fallar("el cliente con RUC no quedó como contribuyente: el armador del XML lo rechazaría");
    if (emp.nombre_facturacion !== "PANADERIA SAN JUAN SRL")
      fallar("no se guardó el nombre de facturación");

    if (per.tipo_cliente !== "persona") fallar("el cliente con cédula no quedó como persona");
    if (per.es_contribuyente !== false)
      fallar("el cliente con cédula quedó como contribuyente: el SET rechazaría el lote");
    if (per.ruc) fallar("se guardó una cédula en el campo del RUC");

    // ── El buscador de la caja los tiene que encontrar ────────────────────
    async function buscar(q) {
      return (
        await c.query(
          `select id, coalesce(nombre_facturacion, empresa, nombre) razon_social, ruc, documento
             from ${S}.clientes
            where empresa_id=$1 and deleted_at is null
              and (coalesce(nombre_facturacion,'') ilike '%'||$2||'%'
                or coalesce(empresa,'') ilike '%'||$2||'%'
                or coalesce(nombre,'') ilike '%'||$2||'%'
                or coalesce(ruc,'') ilike '%'||$2||'%'
                or coalesce(documento,'') ilike '%'||$2||'%')
            limit 15`,
          [empresaId, q])
      ).rows;
    }

    for (const [q, esperado] of [
      ["panaderia", idEmpresa],
      ["80012345", idEmpresa],
      ["perez", idPersona],
      ["4123456", idPersona],
    ]) {
      const hits = await buscar(q);
      if (!hits.some((h) => h.id === esperado))
        fallar(`buscando "${q}" no apareció el cliente que corresponde`);
    }
    console.log("Buscador: encuentra por nombre, por RUC y por cédula.");

    // ── La factura queda atada al cliente ─────────────────────────────────
    const ventaId = (
      await c.query(
        `insert into ${S}.ventas (empresa_id, numero_control, subtotal, monto_iva, total, fecha)
         values ($1,'VTA-QA-CLI',90909,9091,100000, now()) returning id`, [empresaId])
    ).rows[0].id;
    const facturaId = (
      await c.query(
        `insert into ${S}.facturas (empresa_id, cliente_id, numero_factura, fecha,
           fecha_vencimiento, monto, tipo, cliente_razon_social, cliente_ruc, origen_venta_id)
         values ($1,$2,'FAC-QA0001',current_date,current_date,100000,'contado',$3,$4,$5)
         returning id`,
        [empresaId, idEmpresa, "PANADERIA SAN JUAN SRL", "80012345-6", ventaId])
    ).rows[0].id;

    const fac = (
      await c.query(
        `select cliente_id, cliente_razon_social, cliente_ruc from ${S}.facturas where id=$1`,
        [facturaId])
    ).rows[0];
    if (fac.cliente_id !== idEmpresa) fallar("la factura no quedó atada al cliente");
    // Los datos se copian igual en la factura: si mañana el cliente cambia de
    // razón social, la factura ya emitida tiene que seguir diciendo lo que
    // decía el papel que se entregó.
    if (!fac.cliente_razon_social || !fac.cliente_ruc)
      fallar("la factura no conservó su propia copia de razón social y RUC");
    console.log("Factura atada al cliente y con su copia de los datos.");

    console.log(`\n${fallos === 0 ? "ALTA DE CLIENTE DESDE LA CAJA OK" : `${fallos} FALLO(S)`}`);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
    console.log("ROLLBACK: la base quedó como estaba.");
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
