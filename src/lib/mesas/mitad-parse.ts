import type { MitadMitadInput } from "@/lib/mesas/server/mesas-pg";
import { porcionesDeNombre } from "@/lib/ventas/pizza-porciones";

export interface MitadPayload {
  precioUnitario: number | null;
  displayName: string | null;
  mitad: MitadMitadInput | null;
}

/**
 * Lee metadata de pizza mitad y mitad desde el body de un POST de ítem de mesa.
 * Espera (opcional): precio_unitario, display_name y mitad { producto1_id,
 * producto2_id, nombre1, nombre2 }. Si no viene `mitad`, devuelve mitad=null.
 */
export function parseMitadFromBody(o: Record<string, unknown>): MitadPayload {
  const precioRaw = o.precio_unitario;
  const precioUnitario = precioRaw == null || precioRaw === ""
    ? null
    : (Number.isFinite(Number(precioRaw)) && Number(precioRaw) > 0 ? Number(precioRaw) : null);
  const displayName = typeof o.display_name === "string" && o.display_name.trim() ? o.display_name.trim().slice(0, 200) : null;

  let mitad: MitadMitadInput | null = null;
  const m = o.mitad;
  if (m && typeof m === "object") {
    const r = m as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
    mitad = {
      producto1Id: str(r.producto1_id),
      producto2Id: str(r.producto2_id),
      nombre1: str(r.nombre1),
      nombre2: str(r.nombre2),
    };

    // Las dos mitades tienen que ser de la misma medida. La pantalla ya lo
    // impide, pero el precio y los nombres llegan desde el navegador: si acá no
    // se revisa, una petición armada a mano deja en cocina una pizza que no se
    // puede armar y con el precio del sabor más caro, que puede ser el chico.
    const n1 = porcionesDeNombre(mitad.nombre1);
    const n2 = porcionesDeNombre(mitad.nombre2);
    if (n1 != null && n2 != null && n1 !== n2) {
      throw new Error(
        `Las dos mitades tienen que ser de la misma medida: vinieron ${n1} y ${n2} porciones.`
      );
    }
  }
  return { precioUnitario, displayName, mitad };
}
