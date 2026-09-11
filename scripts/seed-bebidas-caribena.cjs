/**
 * Carga las bebidas del conteo "INVENTARIO 24-08 LA CARIBEÑA" como productos
 * de reventa, por marca.
 *
 * Por qué por marca: el menú cobra por tamaño ("Gaseosa 500 ML, Gs. 8.000"),
 * pero el local cuenta Coca, Sprite y Fanta por separado. Con un único producto
 * genérico el sistema nunca sabe qué botella salió de la heladera y el control
 * de stock no sirve. Así que cada marca es un producto vendible con su stock, y
 * las tres genéricas de gaseosa que habían entrado con el menú se desactivan.
 *
 * Precios: se toman del menú por tamaño (250 ML → 5.000, 500 ML → 8.000,
 * 1 L → 12.000). Lo que el menú no cotiza —2 litros, latas, Aquarius, agua
 * tónica, las cervezas importadas y todos los vinos y destilados— queda en 0 y
 * se lista al final para cargarlo a mano.
 *
 * La planilla no trae cantidades para las bebidas (la columna B está vacía en
 * ese bloque), así que entran con stock 0: lo carga la primera compra.
 *
 * Idempotente: saltea por nombre lo que ya existe. Dry-run salvo --commit.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const SCHEMA = "caribenaerp";
const COMMIT = process.argv.includes("--commit");

const CATEGORIAS = [
  { nombre: "BEBIDAS SIN ALCOHOL", codigo: "BSA" },
  { nombre: "CERVEZAS", codigo: "CER" },
  { nombre: "VINOS Y DESTILADOS", codigo: "VYD" },
];

/**
 * Genéricas que entraron con el menú y quedan reemplazadas por las marcas.
 * Se desactivan, no se borran: si hiciera falta volver atrás, alcanza con
 * marcarlas activas de nuevo.
 */
const A_DESACTIVAR = ["GASEOSA 1 LT", "GASEOSA 500 ML", "GASEOSA 250 ML"];

/**
 * Ítems de la planilla que NO se crean porque ya existe el mismo producto
 * cargado desde el menú, con su precio. Se deja el que ya está.
 */
const EQUIVALENCIAS = [
  ["AGUA C/GAS 500ML", "AGUA CON GAS 500 ML"],
  ["AGUA S/GAS 500ML", "AGUA SIN GAS 500 ML"],
  ["JUGO DELVALLE 200 ML", "JUGO DEL VALLE 200 ML"],
  ["MUNICH ORIGINAL 600ML", "BOTELLA ORIGINAL MUNICH 600 ML"],
  ["MUNICH ULTRA 269ML", "BOTELLA ULTRA 269 ML"],
  ["MUNICH ULTRA 600ML", "BOTELLA ULTRA 600 ML"],
];

/** [nombre, precio] — precio 0 = el menú no lo cotiza, hay que cargarlo. */
const BEBIDAS_SIN_ALCOHOL = [
  ["AGUA C/GAS 2L", 0],
  ["AGUA S/GAS 2L", 0],
  ["AGUA TÓNICA 500ML", 0],
  ["COCA COLA 250ML", 5000],
  ["SPRITE 250ML", 5000],
  ["SPRITE 500ML", 8000],
  ["SPRITE ZERO 500ML", 8000],
  ["COCA COLA 500ML", 8000],
  ["FANTA GUARANA 500ML", 8000],
  ["FANTA NARANJA 500ML", 8000],
  ["FANTA PIÑA 500ML", 8000],
  ["COCA COLA ZERO 500ML", 8000],
  ["COCA COLA ORIGINAL LATA", 0],
  ["COCA COLA RETORNABLE 1L", 12000],
  ["COCA COLA ZERO 1L", 12000],
  ["COCA COLA ZERO LATA", 0],
  ["FANTA GUARANA 1L", 12000],
  ["FANTA GUARANA 1L RETORNABLE", 12000],
  ["FANTA NARANJA 1L", 12000],
  ["COCA COLA 1L", 12000],
  ["SPRITE ORIGINAL 1L", 12000],
  ["SPRITE RETORNABLE 1L", 12000],
  ["SPRITE ZERO 2L", 0],
  ["AQUARIUS 1L", 0],
];

const CERVEZAS = [
  ["CERVEZA HEINEKEN", 0],
  ["CERVEZA MILLER", 0],
  ["CERVEZA MUNICH", 0],
  ["MICHELOB ULTRA", 0],
  ["MUNICH ULTRA GLUTEN FREE 269ML", 0],
];

const VINOS_Y_DESTILADOS = [
  ["CORDERO CON PIEL DE LOBO 750ML", 0],
  ["ALMA MORA MABELC 750ML", 0],
  ["TRUMPETER MALBEC 750ML", 0],
  ["VINO BLANCO UVITA", 0],
  ["VHELO BAREIRO", 0],
  ["RON FORTIN", 0],
  ["GIN GORDONS", 0],
  ["VODKA ROSKOFF", 0],
  ["CHANDON DELICE", 0],
  ["CANDON CURVEE RESERVE", 0],
  ["VINO SPUMANTE ROSADO", 0],
  ["SMIRNOFF VODKA", 0],
];

const BLOQUES = [
  ["BEBIDAS SIN ALCOHOL", BEBIDAS_SIN_ALCOHOL],
  ["CERVEZAS", CERVEZAS],
  ["VINOS Y DESTILADOS", VINOS_Y_DESTILADOS],
];

/** SKU con la misma receta que el botón "Generar" del alta manual. */
function skuBase(nombre) {
  const tokens = nombre
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "PROD";
  return [tokens[0].slice(0, 4), tokens[1]?.slice(0, 3)].filter(Boolean).join("-");
}

function corto(nombreEmpresa) {
  return (
    (nombreEmpresa || "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 3) || "EMP"
  );
}

async function main() {
  const c = new Client({ connectionString: CONN });
  await c.connect();
  const q = (sql, p) => c.query(sql, p);

  const { rows: emp } = await q(`select id, nombre_empresa from ${SCHEMA}.empresas limit 1`);
  if (!emp.length) throw new Error("No hay empresa en el schema.");
  const empresaId = emp[0].id;
  const short = corto(emp[0].nombre_empresa);
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  await q("BEGIN");
  try {
    const catId = new Map();
    for (const cat of CATEGORIAS) {
      const ex = await q(
        `select id from ${SCHEMA}.categorias_productos where empresa_id=$1 and upper(nombre)=upper($2) limit 1`,
        [empresaId, cat.nombre]
      );
      if (ex.rows.length) {
        catId.set(cat.nombre, ex.rows[0].id);
        console.log(`cat  =  ${cat.nombre} (ya existía)`);
        continue;
      }
      const ins = await q(
        `insert into ${SCHEMA}.categorias_productos (empresa_id, nombre, codigo) values ($1,$2,$3) returning id`,
        [empresaId, cat.nombre, cat.codigo]
      );
      catId.set(cat.nombre, ins.rows[0].id);
      console.log(`cat  +  ${cat.nombre}`);
    }

    const { rows: usadosRows } = await q(
      `select upper(trim(sku)) sku from ${SCHEMA}.productos where empresa_id=$1`,
      [empresaId]
    );
    const usados = new Set(usadosRows.map((r) => r.sku));

    let creados = 0;
    let saltados = 0;
    const sinPrecio = [];

    for (const [categoria, items] of BLOQUES) {
      const categoriaId = catId.get(categoria);
      console.log(`\n── ${categoria} ─────────────────────────────`);

      for (const [nombre, precio] of items) {
        const ex = await q(
          `select id from ${SCHEMA}.productos where empresa_id=$1 and upper(nombre)=upper($2) limit 1`,
          [empresaId, nombre]
        );
        if (ex.rows.length) {
          saltados++;
          console.log(`  =  ${nombre} (ya existía)`);
          continue;
        }

        const base = skuBase(nombre);
        let n = 1;
        let sku = `${base}-001`;
        while (usados.has(sku) && n < 1000) {
          n++;
          sku = `${base}-${String(n).padStart(3, "0")}`;
        }
        usados.add(sku);

        const { rows: seq } = await q(`select ${SCHEMA}.incrementar_secuencia_producto($1::uuid) as v`, [empresaId]);
        const codigoBarras = `INT-${short}-${ym}-${String(Number(seq[0].v)).padStart(6, "0")}`;

        const { rows: nuevo } = await q(
          `insert into ${SCHEMA}.productos
             (empresa_id, nombre, sku, costo_promedio, precio_venta,
              stock_actual, stock_minimo, unidad_medida, metodo_valuacion,
              codigo_barras, codigo_barras_interno, categoria_principal_id,
              es_vendible, es_insumo, controla_stock, valorizado,
              factor_compra_receta, tiempo_prep_minutos, sector_produccion)
           values ($1,$2,$3,0,$4, 0,0,'UNIDAD','CPP', $5,true,$6, true,false,true,true, 1,0,'ninguno')
           returning id`,
          [empresaId, nombre, sku, precio, codigoBarras, categoriaId]
        );
        await q(
          `insert into ${SCHEMA}.producto_categorias (empresa_id, producto_id, categoria_id, es_principal)
           values ($1,$2,$3,true)`,
          [empresaId, nuevo[0].id, categoriaId]
        );

        if (precio === 0) sinPrecio.push(`${categoria} · ${nombre}`);
        creados++;
        console.log(
          `  +  ${sku.padEnd(14)} ${nombre.padEnd(34)} ${precio > 0 ? "Gs. " + String(precio).padStart(6) : "SIN PRECIO"}`
        );
      }
    }

    console.log(`\n── Genéricas reemplazadas ─────────────────────`);
    let desactivadas = 0;
    for (const nombre of A_DESACTIVAR) {
      const upd = await q(
        `update ${SCHEMA}.productos set activo = false, updated_at = now()
          where empresa_id = $1 and upper(nombre) = upper($2) and activo = true
        returning nombre`,
        [empresaId, nombre]
      );
      if (upd.rowCount) {
        desactivadas++;
        console.log(`  ×  ${nombre} desactivada (la reemplazan las marcas)`);
      } else {
        console.log(`  ·  ${nombre} no estaba activa`);
      }
    }

    console.log(`\n── Ya existían con otro nombre ────────────────`);
    for (const [enPlanilla, enErp] of EQUIVALENCIAS) {
      console.log(`  ·  "${enPlanilla}" = "${enErp}" → se deja el que ya está`);
    }

    console.log(`\nResumen: ${creados} creados, ${saltados} ya existían, ${desactivadas} genéricas desactivadas.`);
    console.log(`\nSin precio de venta (${sinPrecio.length}) — hay que cargarlo antes de venderlos:`);
    for (const s of sinPrecio) console.log(`  · ${s}`);

    if (COMMIT) {
      await q("COMMIT");
      console.log("\nCOMMIT aplicado.");
    } else {
      await q("ROLLBACK");
      console.log("\nDRY-RUN: nada se guardó. Volvé a correr con --commit.");
    }
  } catch (e) {
    await q("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
