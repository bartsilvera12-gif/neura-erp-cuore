"use client";

import { Search, X } from "lucide-react";

/**
 * Buscador de un listado.
 *
 * Existe para que todas las pantallas busquen igual: mismo lugar, misma forma
 * de limpiar, mismo recuento de resultados. Cuando cada listado traía su propia
 * versión, unos filtraban con acentos y otros no, unos tenían botón de limpiar
 * y otros obligaban a borrar a mano.
 *
 * Filtra en el navegador sobre lo que ya está cargado. Alcanza para los
 * listados de un local: son cientos de filas, no millones. Si alguno creciera
 * al punto de no poder traerse entero, ese necesita búsqueda en el servidor y
 * este componente no es la herramienta.
 */
export interface BuscadorListaProps {
  valor: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Cuántos se muestran y cuántos hay, para que el filtro no engañe. */
  mostrando?: number;
  total?: number;
  className?: string;
}

/**
 * Normaliza para comparar: sin mayúsculas, sin acentos y sin espacios de más.
 *
 * Buscar "cafe" tiene que encontrar "CAFÉ". Sin esto el cajero escribe lo que
 * ve y el listado le dice que no hay nada.
 */
export function normalizarBusqueda(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    // Rango de tildes y diéresis que NFD deja sueltas. Escrito con escapes y no
    // con los caracteres literales, que en un editor no se ven y se borran solos.
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * true si todos los términos aparecen en alguno de los campos.
 *
 * Por términos y no por frase entera: "juan gonzalez" encuentra a "González,
 * Juan Carlos", que es como la gente busca de memoria.
 */
export function coincideBusqueda(consulta: string, ...campos: unknown[]): boolean {
  const q = normalizarBusqueda(consulta);
  if (q === "") return true;
  const heno = campos.map(normalizarBusqueda).join(" ");
  return q.split(/\s+/).every((t) => heno.includes(t));
}

export default function BuscadorLista({
  valor,
  onChange,
  placeholder,
  mostrando,
  total,
  className = "",
}: BuscadorListaProps) {
  const filtrando = valor.trim() !== "";
  const hayRecuento = typeof mostrando === "number" && typeof total === "number";

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <div className="relative min-w-48 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="text"
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
        />
        {filtrando && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="Limpiar búsqueda"
            aria-label="Limpiar búsqueda"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Con el filtro puesto se dice cuántos quedaron: si no, una lista corta
          parece que se perdieron datos. */}
      {hayRecuento && filtrando && (
        <p className="text-xs text-slate-500">
          <span className="font-semibold text-slate-800">{mostrando}</span> de {total}
        </p>
      )}
    </div>
  );
}
