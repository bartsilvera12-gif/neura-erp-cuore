import type { SectorComanda } from "@/lib/comandas/types";

/** Etiqueta del sector de producción de una comanda. */
export function SectorBadge({ sector }: { sector: SectorComanda | null }) {
  if (sector === "pizzeria") {
    return <span className="mt-1 inline-block rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">PIZZERÍA · copia completa</span>;
  }
  if (sector === "plancha") {
    return <span className="mt-1 inline-block rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">PLANCHA</span>;
  }
  return <span className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">COCINA</span>;
}
