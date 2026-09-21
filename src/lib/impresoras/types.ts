/**
 * Configuración de impresoras térmicas por sector.
 *
 * En Cucina del Cuore hay tres impresoras físicas conectadas a la red por
 * cable Ethernet — una en el horno, una en la plancha y una en la caja —,
 * cada una con IP fija en la LAN local. El ERP se conecta por TCP al
 * puerto 9100 (RAW ESC/POS) y le manda los bytes del ticket sin diálogo
 * de impresión ni driver de Windows.
 */
export type SectorImpresora = "pizzeria" | "plancha" | "caja";

export interface Impresora {
  id: string;
  sector: SectorImpresora;
  nombre: string | null;
  ip: string;
  puerto: number;
  ancho_mm: 58 | 80;
  activo: boolean;
}

/** Etiquetas humanas de cada sector, para la UI y los tickets. */
export const SECTOR_LABEL: Record<SectorImpresora, string> = {
  pizzeria: "Horno",
  plancha:  "Plancha",
  caja:     "Caja",
};
