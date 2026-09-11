/**
 * Medida de una pizza, leída del nombre del producto.
 *
 * En el menú la medida vive dentro del nombre ("PIZZA HAWAIANA 8 PORCIONES");
 * no hay una columna aparte. Mientras siga siendo así, esta es la única fuente
 * y conviene que sea una sola función y no un regex repetido en cada pantalla.
 *
 * Si algún día la medida pasa a ser un campo del producto, se cambia acá.
 */

/** Porciones que declara el nombre, o null si no declara ninguna. */
export function porcionesDeNombre(nombre: string | null | undefined): number | null {
  const m = /(\d+)\s*PORCION(?:ES)?/i.exec(String(nombre ?? ""));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * El sabor sin la medida ni el "PIZZA" del principio.
 *
 * En la comanda la medida se escribe una vez arriba, grande. Repetirla en cada
 * mitad ("½ PIZZA PEPPERONI 12 PORCIONES + ½ PIZZA RÚCULA 12 PORCIONES") hace
 * una línea larguísima en un papel de 80 mm y esconde justo lo que cocina
 * necesita leer rápido, que son los dos sabores.
 */
export function saborCorto(nombre: string | null | undefined): string {
  return String(nombre ?? "")
    .replace(/\s*\d+\s*PORCION(?:ES)?\s*/i, " ")
    .replace(/^\s*PIZZA\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "12 PORCIONES", para títulos. */
export function etiquetaPorciones(n: number | null): string {
  return n == null ? "" : `${n} PORCIONES`;
}

/**
 * Nombre de una mitad y mitad, con la medida adentro.
 *
 * Se guarda así en el ítem para que la medida viaje sola a la comanda, al
 * ticket y a la factura, sin que cada pantalla la tenga que deducir.
 */
export function nombreMitadMitad(porciones: number | null): string {
  return porciones == null ? "Pizza mitad y mitad" : `Pizza mitad y mitad ${porciones} porciones`;
}
