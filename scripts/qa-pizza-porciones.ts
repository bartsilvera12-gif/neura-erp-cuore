/**
 * QA de la medida de pizza: leerla del nombre, acortar el sabor y bloquear
 * combinaciones de distinta medida.
 *
 *   npx tsx scripts/qa-pizza-porciones.ts
 */
import { porcionesDeNombre, saborCorto, nombreMitadMitad } from "../src/lib/ventas/pizza-porciones";
import { parseMitadFromBody } from "../src/lib/mesas/mitad-parse";

let fallos = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? "OK  " : "FALLA"} ${msg}`);
  if (!cond) fallos++;
}

ok(porcionesDeNombre("PIZZA HAWAIANA 8 PORCIONES") === 8, "lee 8 porciones");
ok(porcionesDeNombre("PIZZA CARNÍVORA 12 PORCIONES") === 12, "lee 12 porciones");
ok(porcionesDeNombre("BORDE MEDIANA") === null, "un borde no tiene medida");
ok(porcionesDeNombre("CAJA P/ PIZZA MEDIANA") === null, "una caja no tiene medida");

ok(saborCorto("PIZZA POLLO CATUPIRY 12 PORCIONES") === "POLLO CATUPIRY", "acorta el sabor");
ok(saborCorto("PIZZA AJO AL OLIVA 4 PORCIONES") === "AJO AL OLIVA", "acorta con nombre largo");

ok(nombreMitadMitad(8) === "Pizza mitad y mitad 8 porciones", "el nombre lleva la medida");
ok(nombreMitadMitad(null) === "Pizza mitad y mitad", "sin medida, el nombre de siempre");

// El servidor no puede confiar en la pantalla.
const mismas = {
  mitad: { producto1_id: "a", producto2_id: "b", nombre1: "PIZZA PEPPERONI 8 PORCIONES", nombre2: "PIZZA RÚCULA 8 PORCIONES" },
};
let paso = true;
try { parseMitadFromBody(mismas); } catch { paso = false; }
ok(paso, "misma medida: pasa");

const distintas = {
  mitad: { producto1_id: "a", producto2_id: "b", nombre1: "PIZZA PEPPERONI 8 PORCIONES", nombre2: "PIZZA RÚCULA 12 PORCIONES" },
};
let rechazo = false;
try { parseMitadFromBody(distintas); } catch (e) { rechazo = /misma medida/.test((e as Error).message); }
ok(rechazo, "8 con 12: el servidor la rechaza");

// Un borde no declara medida: no se inventa un rechazo donde no hay dato.
const sinMedida = {
  mitad: { producto1_id: "a", producto2_id: "b", nombre1: "PIZZA PEPPERONI 8 PORCIONES", nombre2: "BORDE" },
};
let pasoSinMedida = true;
try { parseMitadFromBody(sinMedida); } catch { pasoSinMedida = false; }
ok(pasoSinMedida, "sin medida en una mitad: no se rechaza a ciegas");

console.log(fallos === 0 ? "\nTodo bien." : `\n${fallos} fallas.`);
process.exit(fallos === 0 ? 0 : 1);
