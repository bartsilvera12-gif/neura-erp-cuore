/**
 * Endpoints WSDL SIFEN (TEST y producción). POST al .wsdl, como documenta la SET / integraciones de referencia.
 */
import type { AmbienteSifen } from "./types";

export const SIFEN_WS = {
  test: {
    recepLote: "https://sifen-test.set.gov.py/de/ws/async/recibe-lote.wsdl",
    consultaLote: "https://sifen-test.set.gov.py/de/ws/consultas/consulta-lote.wsdl",
    recibeSync: "https://sifen-test.set.gov.py/de/ws/sync/recibe.wsdl",
    /** siRecepEvento: cancelación (y demás eventos) de un DE por CDC. */
    eventos: "https://sifen-test.set.gov.py/de/ws/eventos/evento.wsdl",
    /** siConsDE: estado real de un DE por CDC, sin depender del lote. */
    consultaDe: "https://sifen-test.set.gov.py/de/ws/consultas/consulta.wsdl",
  },
  produccion: {
    recepLote: "https://sifen.set.gov.py/de/ws/async/recibe-lote.wsdl",
    consultaLote: "https://sifen.set.gov.py/de/ws/consultas/consulta-lote.wsdl",
    recibeSync: "https://sifen.set.gov.py/de/ws/sync/recibe.wsdl",
    eventos: "https://sifen.set.gov.py/de/ws/eventos/evento.wsdl",
    consultaDe: "https://sifen.set.gov.py/de/ws/consultas/consulta.wsdl",
  },
} as const satisfies Record<
  AmbienteSifen,
  { recepLote: string; consultaLote: string; recibeSync: string; eventos: string; consultaDe: string }
>;

export function urlEventos(ambiente: AmbienteSifen): string {
  return SIFEN_WS[ambiente].eventos;
}

export function urlConsultaDe(ambiente: AmbienteSifen): string {
  return SIFEN_WS[ambiente].consultaDe;
}

export function urlRecepLote(ambiente: AmbienteSifen): string {
  return SIFEN_WS[ambiente].recepLote;
}

export function urlConsultaLote(ambiente: AmbienteSifen): string {
  return SIFEN_WS[ambiente].consultaLote;
}

export function urlRecibeSync(ambiente: AmbienteSifen): string {
  return SIFEN_WS[ambiente].recibeSync;
}
