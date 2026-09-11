/**
 * Override opcional de marca para los documentos imprimibles.
 *
 * Cucina del Cuore es un solo local y los datos del emisor salen del XML firmado, que
 * es lo que la SET dio por bueno. Esto existe para que el KUDE ticket pueda
 * recibir un logo o un teléfono propio si algún día hace falta, sin que el
 * documento dependa de constantes escritas en el código.
 */
export type MembreteMarca = {
  logoUrl?: string | null;
  telefono?: string | null;
  direccion?: string[] | null;
};
