"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

export type SmartOption = {
  id: string;
  /** Texto principal (ej. nombre del producto). */
  label: string;
  /** Línea secundaria (ej. "SKU-001 · 4 u."). También se busca. */
  sub?: string;
  /** Texto que se busca pero no se muestra (ej. código de barras, categoría). */
  keywords?: string;
  /** Se muestra en gris y no se puede elegir (ej. producto sin stock). */
  disabled?: boolean;
  /** Etiqueta corta a la derecha de la fila (ej. precio). */
  trailing?: string;
};

/** Normaliza para búsqueda: minúsculas y sin acentos. */
function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Puntaje de coincidencia. Mayor = mejor.
 *
 * Todos los términos tienen que aparecer (búsqueda AND) en label, sub o
 * keywords, pero NO en orden: "coca 500" encuentra "COCA COLA 500ML". Eso es lo
 * que hace usable un buscador de caja, donde se tipea rápido y de memoria.
 */
function score(opt: SmartOption, terms: string[]): number {
  const label = norm(opt.label);
  const hay = `${label} ${norm(opt.sub ?? "")} ${norm(opt.keywords ?? "")}`;
  let total = 0;
  for (const t of terms) {
    if (!hay.includes(t)) return -1;
    if (label.startsWith(t)) total += 100;
    else if (label.split(/[\s/\-.]+/).some((w) => w.startsWith(t))) total += 60;
    else if (label.includes(t)) total += 30;
    else total += 10; // sólo apareció en sub/keywords
  }
  return total;
}

/** Parte el texto para resaltar las coincidencias. */
function highlight(text: string, terms: string[]) {
  if (terms.length === 0) return text;
  const n = norm(text);
  const marks: boolean[] = new Array(text.length).fill(false);
  for (const t of terms) {
    let from = 0;
    for (;;) {
      const i = n.indexOf(t, from);
      if (i < 0) break;
      for (let k = i; k < i + t.length && k < marks.length; k++) marks[k] = true;
      from = i + t.length;
    }
  }
  const out: React.ReactNode[] = [];
  let buf = "";
  let cur = marks[0] ?? false;
  for (let i = 0; i < text.length; i++) {
    if ((marks[i] ?? false) !== cur) {
      out.push(
        cur ? (
          <mark key={i} className="rounded bg-[#4FAEB2]/25 px-0 text-inherit">{buf}</mark>
        ) : (
          buf
        )
      );
      buf = "";
      cur = marks[i] ?? false;
    }
    buf += text[i];
  }
  if (buf) {
    out.push(
      cur ? (
        <mark key="last" className="rounded bg-[#4FAEB2]/25 px-0 text-inherit">{buf}</mark>
      ) : (
        buf
      )
    );
  }
  return out;
}

/**
 * Combobox con búsqueda: escribís y filtra al instante.
 *
 * - Multi-término y sin orden ("coca 500" encuentra "COCA COLA 500ML").
 * - Ignora acentos y mayúsculas; también busca en SKU y keywords.
 * - ↑ ↓ para moverse, Enter para elegir, Esc para cerrar.
 * - `focusSignal`: cada vez que cambia el número, se abre y toma el foco. Sirve
 *   para volver al buscador después de agregar un ítem al carrito, que es el
 *   ciclo normal de una caja.
 *
 * Dos variantes:
 * - "select": se ve como un campo con el valor elegido, y se abre al hacer clic.
 *   Sirve cuando el formulario tiene que mostrar qué quedó seleccionado.
 * - "buscador": la caja de búsqueda queda siempre visible y grande, y al elegir
 *   se limpia y conserva el foco. Sirve cuando elegir NO es seleccionar sino
 *   ejecutar una acción — agregar el producto a la venta y seguir buscando.
 */
export default function SmartSearchSelect({
  options,
  value,
  onChange,
  placeholder = "Buscar…",
  emptyText = "Sin resultados",
  required = false,
  name,
  maxResults = 50,
  focusSignal,
  className = "",
  variant = "select",
}: {
  options: SmartOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  emptyText?: string;
  required?: boolean;
  name?: string;
  maxResults?: number;
  focusSignal?: number;
  className?: string;
  variant?: "select" | "buscador";
}) {
  const esBuscador = variant === "buscador";
  const [open, setOpen] = useState(esBuscador);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);
  const terms = useMemo(() => norm(query).split(/\s+/).filter(Boolean), [query]);

  const results = useMemo(() => {
    if (terms.length === 0) return options.slice(0, maxResults);
    return options
      .map((o) => ({ o, s: score(o, terms) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.o.label.localeCompare(b.o.label))
      .slice(0, maxResults)
      .map((x) => x.o);
  }, [options, terms, maxResults]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current?.contains(e.target as Node)) return;
      if (esBuscador) setQuery("");
      else setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [esBuscador]);

  /** Mantener la opción activa a la vista al navegar con el teclado. */
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (focusSignal === undefined || focusSignal === 0) return;
    setOpen(true);
    setQuery("");
    setActive(0);
    // El input recién existe cuando `open` pinta; por eso el tick de espera.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [focusSignal]);

  function choose(o: SmartOption) {
    if (o.disabled) return;
    onChange(o.id);
    setQuery("");
    setActive(0);
    if (esBuscador) inputRef.current?.focus();
    else setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      setActive(0);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) choose(r);
    } else if (e.key === "Escape") {
      if (esBuscador) setQuery("");
      else setOpen(false);
    }
  }

  const base = esBuscador
    ? "h-12 w-full rounded-xl border-2 border-[#4FAEB2]/35 bg-white px-3 text-base text-slate-900 " +
      "outline-none transition-all placeholder:text-slate-400 focus:border-[#4FAEB2] " +
      "focus:ring-4 focus:ring-[#4FAEB2]/15"
    : "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm " +
      "outline-none transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 " +
      "focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      {/* Espejo oculto para la validación nativa del form */}
      {name && (
        <input
          type="text"
          name={name}
          value={value}
          required={required}
          onChange={() => {}}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute h-0 w-0 opacity-0"
        />
      )}

      {open ? (
        <div className="relative">
          <Search
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${
              esBuscador ? "left-4 h-5 w-5 text-[#4FAEB2]" : "left-3 h-4 w-4 text-slate-400"
            }`}
          />
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            className={`${base} ${esBuscador ? "pl-12 pr-10" : "pl-9 pr-9"}`}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
              aria-label="Limpiar búsqueda"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
          className={`${base} flex items-center justify-between gap-2 text-left`}
        >
          <span className={`min-w-0 flex-1 truncate ${selected ? "text-slate-900" : "text-slate-400"}`}>
            {selected ? selected.label : placeholder}
            {selected?.sub && <span className="ml-2 text-xs text-slate-400">{selected.sub}</span>}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
      )}

      {open && (!esBuscador || query.trim() !== "") && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
        >
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-slate-400">{emptyText}</li>
          ) : (
            results.map((o, i) => {
              const isSel = !esBuscador && o.id === value;
              return (
                <li
                  key={o.id}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(o); }}
                  className={`flex items-start gap-2 px-3 py-2 text-sm ${
                    o.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                  } ${i === active && !o.disabled ? "bg-[#4FAEB2]/10" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-800">{highlight(o.label, terms)}</span>
                    {o.sub && (
                      <span className="block truncate text-xs text-slate-500">{highlight(o.sub, terms)}</span>
                    )}
                  </span>
                  {o.trailing && (
                    <span className="shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-slate-600">
                      {o.trailing}
                    </span>
                  )}
                  {isSel && <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#3F8E91]" />}
                </li>
              );
            })
          )}
          {options.length > results.length && terms.length === 0 && (
            <li className="px-3 py-1.5 text-center text-[11px] text-slate-400">
              Mostrando {results.length} de {options.length} — escribí para buscar
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
