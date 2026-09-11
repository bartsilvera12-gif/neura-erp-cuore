/**
 * Carga los insumos del conteo "INVENTARIO 24-08 LA CARIBEÑA" en el ERP.
 *
 * Qué trae la planilla: nombre en la columna A y cantidad contada en la B.
 * No trae unidades, ni costos, ni precios. Entonces:
 *   - La cantidad entra como stock_actual + un movimiento `inventario_inicial`
 *     fechado el 24/08, que es el día del conteo. Así queda la trazabilidad de
 *     de dónde salió ese número.
 *   - El costo queda en 0: se va a ir armando con las compras. Sin costo no hay
 *     valuación, pero inventar uno sería peor.
 *   - La unidad se toma del nombre cuando la dice ("SAL KG", "HUEVOS UN.") y se
 *     infiere en el resto. Cada ítem lleva marcado si la unidad es explícita o
 *     inferida, y al final se lista lo inferido para que se revise.
 *
 * Sólo carga los bloques de cocina. Las bebidas de la planilla (gaseosas,
 * cervezas, vinos) se dejan afuera a propósito: pisan a los productos de
 * reventa que ya se cargaron desde el menú y hay que decidir antes si el ERP
 * vende "GASEOSA 500 ML" genérica o cada marca por separado.
 *
 * Idempotente: saltea por nombre lo que ya existe. Dry-run salvo --commit.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const SCHEMA = "caribenaerp";
const COMMIT = process.argv.includes("--commit");
/** Día del conteo, según el nombre de la planilla. */
const FECHA_CONTEO = "2026-08-24";

const CATEGORIAS = [
  { nombre: "INSUMOS COCINA", codigo: "INS" },
  { nombre: "PREPARACIONES", codigo: "PRE" },
  { nombre: "DESCARTABLES", codigo: "DES" },
];

/**
 * [nombre, cantidad|null, unidad, explicita]
 * `explicita` = la unidad la dice el propio nombre en la planilla.
 */
const INSUMOS_COCINA = [
  ["ACEITE", 34.3, "LT", false],
  ["ACEITE DE OLIVA", 1.5, "LT", false],
  ["AJO", 0.385, "KG", false],
  ["SAL KG", 1, "KG", true],
  ["AZÚCAR KG", 0.2, "KG", true],
  ["ESENCIA DE VAINILLA", 0.5, "LT", false],
  ["CEBOLLA BLANCA KG", 2.645, "KG", true],
  ["CEBOLLA MORADA KG", 2.295, "KG", true],
  ["CHAMPIÑÓN KG", 0.47, "KG", true],
  ["CHOCLO LATA KG", 0.51, "KG", true],
  ["PIMIENTA NEGRA", 0.4, "KG", false],
  ["CONDIMENTO P/POLLO KG", 0.02, "KG", true],
  ["CONDIMENTO P/CARNE", 0.05, "KG", false],
  ["CONDIMENTO P/PESTO", 0.11, "KG", false],
  ["DURAZNO LATA", null, "UNIDAD", false],
  ["FAJITAS PARA TACOS UN.", 11, "UNIDAD", true],
  ["FRUTILLA LATA", null, "UNIDAD", false],
  ["GAS", null, "UNIDAD", false],
  ["HARINA DE TRIGO 000 25KG", 12.5, "KG", true],
  ["HUEVOS UN.", 30, "UNIDAD", true],
  ["JAMÓN AHUMADO", 0.49, "KG", false],
  ["JAMON COCIDO", null, "KG", false],
  ["KETCHUP KG", 3.1, "KG", true],
  ["LATA DE TOMATE TRITURADO", null, "UNIDAD", false],
  ["LAVANDINA", null, "LT", false],
  ["LECHUGA", 2, "KG", false],
  ["LEVADURA", 0.05, "KG", false],
  ["LIMON", 1.815, "KG", false],
  ["MANTECA", null, "KG", false],
  ["MENTA", null, "KG", false],
  ["MORRON ROJO", 1.095, "KG", false],
  ["MORRON VERDE", 1.065, "KG", false],
  ["MOSTAZA", null, "KG", false],
  ["NARANJA FRUTA KG", 1.965, "KG", true],
  ["ORÉGANO", 0.56, "KG", false],
  ["PALMITO", 1.18, "KG", false],
  ["PAN", null, "UNIDAD", false],
  ["PAN ÁRABE UN.", 20, "UNIDAD", true],
  ["PAN DE LOMITO", null, "UNIDAD", false],
  ["PAN HAMBUERGUESA", null, "UNIDAD", false],
  ["PAN SAND.", null, "UNIDAD", false],
  ["PANCETA", 0.78, "KG", false],
  ["PAPAS FRITAS", 5.785, "KG", false],
  ["PECHUGA", 1.885, "KG", false],
  ["PEPPERONI", 1.55, "KG", false],
  ["PIMENTON DULCE", 0.14, "KG", false],
  ["PIÑA LATA", null, "UNIDAD", false],
  ["PREPIZZAS CHICAS", 14, "UNIDAD", false],
  ["PREPIZZAS FAMILIAR", 18, "UNIDAD", false],
  ["PREPIZZAS MEDIANAS", 13, "UNIDAD", false],
  ["PREPIZZAS MEDIANAS C/BORDE S/BORDE", 13, "UNIDAD", false],
  ["PULPA DE 1ERA", 4.865, "KG", false],
  ["SAMBARI", 2.952, "KG", false],
  ["CARNE MOLIDA", 11.585, "KG", false],
  ["QUESO CATUPIRY MANGA", 0.94, "KG", false],
  ["QUESO CHEDDAR FETAS", 0.07, "KG", false],
  ["QUESO CHEDDAR MANGA KG", 1.78, "KG", true],
  ["QUESO MUZZARELLA", 30.725, "KG", false],
  ["QUESO RALLADO", 0.12, "KG", false],
  ["QUESO AZUL", 0.195, "KG", false],
  ["QUESO ROQUEFORT", null, "KG", false],
  ["RAPIDITAS CALSICAS", 110, "UNIDAD", false],
  ["RAPIDITAS XXL", 13, "UNIDAD", false],
  ["REPOLLO MORADO", 1.155, "KG", false],
  ["RÚCULA", 0.045, "KG", false],
  ["SAL FINA", 1, "KG", false],
  ["SALSA DE SOJA", 0.5, "LT", false],
  ["SALSA PICANTE", null, "LT", false],
  ["TOMATE", 15, "KG", false],
  ["TOMATE CONFITADO", null, "KG", false],
  ["TORTILLAS TIA ROSA", null, "UNIDAD", false],
  // 340 en KG serían 340 kg de pasas: la unidad casi seguro es gramos.
  ["PASAS DE UVA", 340, "G", false],
  ["VINAGRE", 1, "LT", false],
  ["ZANAHORIA", 0.74, "KG", false],
];

/** Bloque sin título de la planilla: lo que la cocina deja cocido y pesa aparte. */
const PREPARACIONES = [
  ["DEMECHADO DE POLLO COCIDO", 3.5, "KG", false],
  ["POLLO EN TIRAS COCIDO", 1.85, "KG", false],
  ["PEPINILLOS", 0.3, "KG", false],
  ["SALSA P/ PIZZAS", 5.03, "KG", false],
  ["CARNE DESMECHADA", 6.76, "KG", false],
  ["CARNE P/LOMITO", 0.32, "KG", false],
  ["CARNE MOLIDA CICIDA", 2.75, "KG", false],
];

const DESCARTABLES = [
  ["CAJA RECTANGULAR", null, "UNIDAD", false],
  ["CAJAS P/PIZZAS", null, "UNIDAD", false],
  ["CAJAS P/PIZZAS 32X32X3.7", null, "UNIDAD", false],
  ["CAJAS P/PIZZAS 40X40X3.7", null, "UNIDAD", false],
];

/**
 * Filas de la planilla que a propósito NO se cargan, con el motivo. Se imprime
 * al final para que quede a la vista qué quedó afuera y por qué.
 */
const OMITIDOS = [
  ["SAMBARÍ (fila 123)", "duplicado exacto de SAMBARI (fila 107), misma cantidad 2,952"],
  ["MERMA (fila 139)", "es una línea de control de desperdicio, no un insumo"],
  ["CARNE? (fila 140)", "el nombre quedó con signo de pregunta: no se sabe qué es"],
];

const BLOQUES = [
  ["INSUMOS COCINA", INSUMOS_COCINA],
  ["PREPARACIONES", PREPARACIONES],
  ["DESCARTABLES", DESCARTABLES],
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
    let conStock = 0;
    const inferidos = [];

    for (const [categoria, items] of BLOQUES) {
      const categoriaId = catId.get(categoria);
      console.log(`\n── ${categoria} ─────────────────────────────`);

      for (const [nombre, cantidad, unidad, explicita] of items) {
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

        const stock = cantidad == null ? 0 : cantidad;
        const { rows: nuevo } = await q(
          `insert into ${SCHEMA}.productos
             (empresa_id, nombre, sku, costo_promedio, precio_venta,
              stock_actual, stock_minimo, unidad_medida, metodo_valuacion,
              codigo_barras, codigo_barras_interno, categoria_principal_id,
              es_vendible, es_insumo, controla_stock, valorizado,
              unidad_receta, factor_compra_receta, tiempo_prep_minutos, sector_produccion)
           values ($1,$2,$3,0,0, $4,0,$5,'CPP', $6,true,$7, false,true,true,true, $5,1,0,'ninguno')
           returning id`,
          [empresaId, nombre, sku, stock, unidad, codigoBarras, categoriaId]
        );
        const productoId = nuevo[0].id;

        await q(
          `insert into ${SCHEMA}.producto_categorias (empresa_id, producto_id, categoria_id, es_principal)
           values ($1,$2,$3,true)`,
          [empresaId, productoId, categoriaId]
        );

        // El stock no aparece de la nada: queda el movimiento que lo explica.
        if (stock > 0) {
          await q(
            `insert into ${SCHEMA}.movimientos_inventario
               (empresa_id, producto_id, producto_nombre, producto_sku, tipo, cantidad,
                costo_unitario, origen, referencia, fecha)
             values ($1,$2,$3,$4,'ENTRADA',$5, 0,'inventario_inicial',$6,$7::date)`,
            [empresaId, productoId, nombre, sku, stock, "Conteo 24-08", FECHA_CONTEO]
          );
          conStock++;
        }

        if (!explicita && cantidad != null) inferidos.push(`${nombre} → ${unidad}`);
        creados++;
        console.log(
          `  +  ${sku.padEnd(14)} ${nombre.padEnd(36)} ${String(stock).padStart(8)} ${unidad.padEnd(6)} ${explicita ? "" : "(unidad inferida)"}`
        );
      }
    }

    console.log(`\nResumen: ${creados} creados, ${saltados} ya existían, ${conStock} con stock inicial.`);

    console.log(`\nFilas que NO se cargaron:`);
    for (const [fila, motivo] of OMITIDOS) console.log(`  · ${fila}: ${motivo}`);

    console.log(`\nUnidades inferidas (${inferidos.length}) — conviene revisarlas en Inventario:`);
    for (const i of inferidos) console.log(`  · ${i}`);

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
