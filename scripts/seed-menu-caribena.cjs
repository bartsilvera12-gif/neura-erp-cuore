/**
 * Carga el menú impreso de La Caribeña en el inventario del ERP.
 *
 * Reglas de negocio que se aplican acá (idénticas a las del alta manual en
 * /inventario/nuevo):
 *   - Menú    → es_vendible, NO es_insumo, controla_stock = false. Son platos
 *               que se arman al momento; el stock lo descuentan sus recetas.
 *   - Reventa → es_vendible, NO es_insumo, controla_stock = true. Se compran
 *               cerradas y se descuentan al venderse.
 *
 * Cada tamaño de pizza es un producto propio porque el modelo tiene un solo
 * precio_venta por producto — es la misma convención que ya traía el catálogo
 * ("PIZZA MARGARITA 4 PORCIONES").
 *
 * Idempotente: saltea por nombre lo que ya existe. Corre en dry-run salvo
 * que se pase --commit.
 */
const { Client } = require("pg");

const CONN = process.env.PG_URL || "postgresql://postgres:NeuraDB2026@187.77.247.54:6432/postgres?sslmode=disable";
const SCHEMA = "caribenaerp";
const COMMIT = process.argv.includes("--commit");

// ─── Categorías ───────────────────────────────────────────────────────────
const CATEGORIAS = [
  { nombre: "PIZZAS", codigo: "PIZ" },
  { nombre: "ALGO DIFERENTE", codigo: "ALG" },
  { nombre: "PAPAS FRITAS", codigo: "PAP" },
  { nombre: "JUGOS NATURALES", codigo: "JUG" },
  { nombre: "TRAGOS", codigo: "TRA" },
  { nombre: "BEBIDAS SIN ALCOHOL", codigo: "BSA" },
  { nombre: "CERVEZAS", codigo: "CER" },
];

// ─── Pizzas: [sabor, descripción, 4P, 8P, 12P] ────────────────────────────
const PIZZAS = [
  ["MARGARITA", "Salsa de tomate, mozzarella, tomate fresco, albahaca y aceitunas.", 30000, 55000, 75000],
  ["PEPPERONI", "Salsa de tomate, mozzarella, pepperoni y aceitunas.", 35000, 70000, 90000],
  ["POLLO CATUPIRY", "Salsa de tomate, mozzarella, pollo salteado, queso catupiry y aceitunas.", 35000, 65000, 85000],
  ["PALMITO", "Salsa de tomate, muzzarella, palmito y aceitunas.", 35000, 65000, 80000],
  ["CARNÍVORA", "Salsa de tomate, muzzarella, carne vacuna desmechada, queso catupiry y aceitunas.", 40000, 80000, 95000],
  ["HAWAIANA", "Salsa de tomate, muzzarella, jamón ahumado, piña confitada y aceitunas.", 35000, 65000, 85000],
  ["NAPOLITANA", "Salsa de tomate, mozzarella, tomate fresco y aceitunas.", 30000, 55000, 75000],
  ["RÚCULA", "Salsa de tomate, muzzarella, jamón ahumado, rúcula fresca, aceite de oliva, parmesano y aceitunas.", 35000, 60000, 80000],
  ["MEXICANA", "Salsa de tomate, muzzarella, carne molida picante, morrón, cebolla y aceitunas.", 40000, 70000, 90000],
  ["CUATRO QUESOS", "Salsa de tomate, muzzarella, queso parmesano, queso azul, queso sardo y aceitunas.", 35000, 75000, 90000],
  ["VEGETARIANA", "Salsa de tomate, muzzarella, choclo, morrón, tomate, palmito y champiñones.", 30000, 60000, 80000],
  ["CHILENA", "Salsa de tomate, muzzarella, carne molida, uvas pasas y aceituna.", 40000, 70000, 90000],
  ["JAMÓN Y QUESO", "Salsa de tomate, muzzarella, jamón ahumado, tomate y aceitunas.", 35000, 65000, 85000],
  ["CRIOLLA", "Salsa de tomate, muzzarella, carne desmechada, huevo frito, cebolla y aceitunas.", 40000, 75000, 95000],
  ["CHAMPIÑONES", "Salsa de tomate, muzzarella, champiñones, cebolla y aceitunas.", 35000, 65000, 85000],
  ["AJO AL OLIVA", "Salsa de tomate, muzzarella, ajos confitados, aceite de oliva extra virgen y aceitunas.", 30000, 55000, 75000],
  ["PANCETA IMPERIAL", "Salsa de tomate, muzzarella, panceta crujiente, queso azul y aceitunas.", 40000, 70000, 90000],
  ["SALCHIPIZZA", "Salsa de tomate, mozzarella, tomate fresco, salchicas crocantes, chips de papas y aceitunas.", 35000, 55000, 75000],
];

const TAMANIOS = [
  [4, "4 PORCIONES"],
  [8, "8 PORCIONES"],
  [12, "12 PORCIONES"],
];

/** Plato preparado por el local: no lleva stock propio. */
function menu(categoria, sector, nombre, precio, descripcion) {
  return { categoria, sector, nombre, precio, descripcion, reventa: false };
}
/** Producto comprado cerrado: lleva stock y se descuenta al venderse. */
function reventa(categoria, nombre, precio) {
  return { categoria, sector: "ninguno", nombre, precio, descripcion: null, reventa: true };
}

const PRODUCTOS = [];

for (const [sabor, desc, p4, p8, p12] of PIZZAS) {
  const precios = { 4: p4, 8: p8, 12: p12 };
  for (const [n, etiqueta] of TAMANIOS) {
    PRODUCTOS.push(menu("PIZZAS", "pizzeria", `PIZZA ${sabor} ${etiqueta}`, precios[n], desc));
  }
}

for (const [nombre, precio, desc] of [
  ["SÁNDWICH DE CARNE DESMECHADA", 30000, "Pan casero, salsa de la casa, carne de res desmechada, morrones, tomates confitados y lechuga."],
  ["SÁNDWICH DE LOMITO", 35000, "Lomito vacuno, pan casero, lechuga repollada, tomate, cebolla caramelizada, huevo, queso mozzarella, pepinillos y panceta crocante."],
  ["HAMBURGUESA SIMPLE", 20000, "Pan casero, carne, lechuga repollada, tomate, queso mozzarella, jamón y huevo."],
  ["HAMBURGUESA DOBLE", 25000, "Pan casero, doble carne, lechuga repollada, tomate, queso cheddar, jamón y huevo."],
  ["HAMBURGUESA PREMIUM", 35000, "Pan casero, doble carne, lechuga repollada, tomate, huevo, panceta, queso cheddar y pepinillos."],
  ["COMBO TACO CARIBEÑO 2 UNIDADES", 25000, "Tortilla casera, base de queso cheddar o mozzarella, relleno de carne desmechada vacuna, repollo y lechuga + 2 salsas opcionales (criolla, picante o ajo)."],
  ["COMBO TACO SUPREME 4 UNIDADES", 45000, "Tortilla casera, base de queso cheddar o mozzarella, relleno de carne desmechada vacuna, repollo y lechuga + 2 salsas opcionales (criolla, picante o ajo) + papas fritas."],
  ["COMBO TACO CARIBEÑO 5 UNIDADES", 50000, "Tortilla casera, base de queso cheddar o mozzarella, relleno de carne desmechada vacuna, repollo y lechuga + 2 salsas opcionales (criolla, picante o ajo) + papas fritas."],
  ["BURRITOS AL ESTILO CUBANO", 45000, "Tortilla casera, base de queso mozzarella, relleno de carne desmechada vacuna, panceta, queso cheddar, pepinillos + papas fritas."],
  ["LOMITO ÁRABE DE CARNE", 25000, "Pan árabe, carne, salsa de ajo, repollo y tomate confitado."],
  ["LOMITO ÁRABE DE POLLO", 20000, "Pan árabe, pollo, salsa de ajo, repollo y tomate confitado."],
  ["LOMITO ÁRABE MIXTO", 22000, "Pan árabe, carne y pollo, salsa de ajo, repollo y tomate confitado."],
]) PRODUCTOS.push(menu("ALGO DIFERENTE", "plancha", nombre, precio, desc));

for (const [nombre, precio, desc] of [
  ["PAPAS FRITAS CHICA", 10000, "Porción de 150 gr."],
  ["PAPAS FRITAS MEDIANA", 15000, "Porción de 200 gr."],
  ["PAPAS FRITAS GRANDE", 20000, "Porción de 300 gr."],
  ["TOPPING QUESO CHEDDAR", 10000, "Topping para papas fritas."],
  ["TOPPING QUESO MUZZARELLA", 10000, "Topping para papas fritas."],
  ["TOPPING PANCETA CRUJIENTE", 10000, "Topping para papas fritas."],
]) PRODUCTOS.push(menu("PAPAS FRITAS", "plancha", nombre, precio, desc));

// Los jugos se venden por jarra chica o grande: un producto por tamaño.
for (const [sabor, chica, grande] of [
  ["NARANJA", 25000, 45000],
  ["DURAZNO", 25000, 45000],
  ["PIÑA", 25000, 45000],
  ["FRUTILLA", 30000, 50000],
]) {
  PRODUCTOS.push(menu("JUGOS NATURALES", "ninguno", `JUGO DE ${sabor} JARRA CHICA`, chica, "Jugo natural. Sabores según temporada."));
  PRODUCTOS.push(menu("JUGOS NATURALES", "ninguno", `JUGO DE ${sabor} JARRA GRANDE`, grande, "Jugo natural. Sabores según temporada."));
}

for (const [nombre, precio, desc] of [
  ["MOJITO CUBANO", 25000, "Ron, limón, azúcar, menta, agua mineral y soda."],
  ["DAIQUIRI DE DURAZNO", 25000, "Ron blanco, limón y azúcar."],
  ["DAIQUIRI DE FRUTILLA", 30000, "Ron blanco, limón y azúcar."],
  ["GIN TONIC", 30000, "Gin, agua tónica, naranja y limón."],
  ["CAIPIROSKA", 25000, "Vodka, limón y azúcar."],
  ["CAIPIRINHA", 20000, "Cachaça, limón y azúcar."],
  ["APEROL SPRITZ", 30000, "Aperol, espumante y rodajas de naranja."],
  ["FERNET", 30000, "Fernet y Coca Cola / Coca Cola Zero."],
  ["JARRA DE SANGRÍA", 40000, "Vino tinto, fruta fresca (de temporada), azúcar y soda."],
]) PRODUCTOS.push(menu("TRAGOS", "ninguno", nombre, precio, desc));

for (const [nombre, precio] of [
  ["GASEOSA 1 LT", 12000],
  ["GASEOSA 500 ML", 8000],
  ["GASEOSA 250 ML", 5000],
  ["AGUA CON GAS 500 ML", 5000],
  ["AGUA SIN GAS 500 ML", 5000],
  ["JUGO DEL VALLE 200 ML", 5000],
]) PRODUCTOS.push(reventa("BEBIDAS SIN ALCOHOL", nombre, precio));

for (const [nombre, precio] of [
  ["CHOPP MUNICH 300 ML", 10000],
  ["CHOPP MUNICH 500 ML", 15000],
  ["BOTELLA ULTRA 269 ML", 7000],
  ["BOTELLA ULTRA 600 ML", 15000],
  ["BOTELLA ORIGINAL MUNICH 600 ML", 13000],
]) PRODUCTOS.push(reventa("CERVEZAS", nombre, precio));

// ─── SKU: misma receta que el botón "Generar" del alta manual ─────────────
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
    let recategorizados = 0;

    for (const p of PRODUCTOS) {
      const categoriaId = catId.get(p.categoria);
      const ex = await q(
        `select id, categoria_principal_id from ${SCHEMA}.productos where empresa_id=$1 and upper(nombre)=upper($2) limit 1`,
        [empresaId, p.nombre]
      );
      if (ex.rows.length) {
        // Ya estaba cargado a mano: sólo se le engancha la categoría si le falta.
        if (!ex.rows[0].categoria_principal_id) {
          await q(`update ${SCHEMA}.productos set categoria_principal_id=$1, updated_at=now() where id=$2`, [
            categoriaId,
            ex.rows[0].id,
          ]);
          await q(
            `insert into ${SCHEMA}.producto_categorias (empresa_id, producto_id, categoria_id, es_principal) values ($1,$2,$3,true)`,
            [empresaId, ex.rows[0].id, categoriaId]
          );
          recategorizados++;
        }
        saltados++;
        console.log(`prod =  ${p.nombre} (ya existía)`);
        continue;
      }

      const base = skuBase(p.nombre);
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
           (empresa_id, nombre, descripcion, sku, costo_promedio, precio_venta,
            stock_actual, stock_minimo, unidad_medida, metodo_valuacion,
            codigo_barras, codigo_barras_interno, categoria_principal_id,
            es_vendible, es_insumo, controla_stock, valorizado,
            factor_compra_receta, tiempo_prep_minutos, sector_produccion)
         values ($1,$2,$3,$4,0,$5, 0,0,'UNIDAD','CPP', $6,true,$7, true,false,$8,true, 1,0,$9)
         returning id`,
        [empresaId, p.nombre, p.descripcion, sku, p.precio, codigoBarras, categoriaId, p.reventa, p.sector]
      );
      await q(
        `insert into ${SCHEMA}.producto_categorias (empresa_id, producto_id, categoria_id, es_principal) values ($1,$2,$3,true)`,
        [empresaId, nuevo[0].id, categoriaId]
      );
      creados++;
      console.log(
        `prod +  ${sku.padEnd(14)} ${p.nombre.padEnd(40)} Gs. ${String(p.precio).padStart(6)}  ${p.reventa ? "[reventa]" : "[menú]"}`
      );
    }

    console.log(`\nResumen: ${creados} creados, ${saltados} ya existían (${recategorizados} recategorizados).`);
    if (COMMIT) {
      await q("COMMIT");
      console.log("COMMIT aplicado.");
    } else {
      await q("ROLLBACK");
      console.log("DRY-RUN: nada se guardó. Volvé a correr con --commit.");
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
