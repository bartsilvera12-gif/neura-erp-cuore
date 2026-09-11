"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type FancySelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type FancySelectProps = {
  options: FancySelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  openDirection?: "auto" | "up" | "down";
};

const TRIGGER_BASE =
  "group relative flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white text-left text-slate-900 shadow-sm transition-all hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

/**
 * Combobox premium con paleta Zentra. Reemplaza a `<select>` nativo.
 *
 * Soporta:
 *  - Teclado: ArrowUp/Down, Home/End, Enter/Space, Escape, Tab
 *  - Click afuera cierra
 *  - Detección automática de dirección (drop-up cuando el listado no entra abajo)
 *  - Opciones con descripción
 *  - Estados disabled (componente y por opción)
 *
 * El desplegable se monta en un portal sobre `document.body` con posición
 * `fixed`, no como hijo absoluto del trigger. Por qué: casi todos los
 * contenedores del ERP (`card` lleva `overflow-hidden` para que la tabla
 * respete el radio, y las tablas con scroll horizontal llevan `overflow-x-auto`)
 * recortaban la lista, que aparecía cortada a una línea y media. Un ancestro
 * con overflow recorta a cualquier descendiente absoluto, por más z-index que
 * tenga; salir del árbol es la única forma de no depender de eso.
 */
export function FancySelect({
  options,
  value,
  onChange,
  placeholder = "Seleccionar…",
  ariaLabel,
  className = "",
  size = "md",
  disabled = false,
  openDirection = "auto",
}: FancySelectProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxId = useId();

  /** Geometría del desplegable en coordenadas de viewport (position: fixed). */
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  /** `document` no existe en el render del servidor: el portal espera al cliente. */
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value]
  );

  const selectableIndexes = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i !== -1),
    [options]
  );

  const openMenu = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    const currentIdx = options.findIndex((o) => o.value === value);
    setActiveIndex(currentIdx >= 0 ? currentIdx : selectableIndexes[0] ?? -1);
  }, [disabled, options, value, selectableIndexes]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const toggleMenu = useCallback(() => {
    if (open) closeMenu();
    else openMenu();
  }, [open, openMenu, closeMenu]);

  const selectByIndex = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      closeMenu();
      triggerRef.current?.focus();
    },
    [options, onChange, closeMenu]
  );

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      // El menú vive fuera del árbol del trigger: hay que preguntarle también
      // a él, o el primer click sobre una opción cerraría antes de elegirla.
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      closeMenu();
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, closeMenu]);

  /**
   * Calcula dónde y con qué alto va el desplegable. Abre hacia abajo salvo que
   * no entre y arriba haya más lugar; en cualquier caso el alto se recorta al
   * espacio real, así nunca queda medio menú fuera de la pantalla.
   */
  const medir = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const MARGEN = 8;
    const SEPARACION = 6;
    const libreAbajo = window.innerHeight - rect.bottom - SEPARACION - MARGEN;
    const libreArriba = rect.top - SEPARACION - MARGEN;
    const alto = Math.min(260, options.length * 40 + 8);

    const haciaArriba =
      openDirection === "up"
        ? true
        : openDirection === "down"
          ? false
          : alto > libreAbajo && libreArriba > libreAbajo;

    const disponible = Math.max(120, haciaArriba ? libreArriba : libreAbajo);
    const maxHeight = Math.min(260, disponible);

    setPos({
      left: rect.left,
      width: rect.width,
      top: haciaArriba ? rect.top - SEPARACION - maxHeight : rect.bottom + SEPARACION,
      maxHeight,
    });
  }, [openDirection, options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    medir();
    // `capture` para enterarse también del scroll de contenedores internos
    // (tablas con overflow), que no burbujea hasta window.
    window.addEventListener("scroll", medir, true);
    window.addEventListener("resize", medir);
    return () => {
      window.removeEventListener("scroll", medir, true);
      window.removeEventListener("resize", medir);
    };
  }, [open, medir]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function moveActive(delta: number) {
    if (!options.length) return;
    const enabled = options
      .map((o, i) => (o.disabled ? -1 : i))
      .filter((i) => i !== -1);
    if (!enabled.length) return;
    const currentPos = enabled.indexOf(activeIndex);
    const nextPos =
      currentPos === -1
        ? delta > 0
          ? 0
          : enabled.length - 1
        : (currentPos + delta + enabled.length) % enabled.length;
    setActiveIndex(enabled[nextPos]);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openMenu();
      else moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openMenu();
      else moveActive(-1);
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      const first = options.findIndex((o) => !o.disabled);
      if (first >= 0) setActiveIndex(first);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      let last = -1;
      for (let i = options.length - 1; i >= 0; i--) {
        if (!options[i].disabled) {
          last = i;
          break;
        }
      }
      if (last >= 0) setActiveIndex(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) openMenu();
      else if (activeIndex >= 0) selectByIndex(activeIndex);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      closeMenu();
    } else if (e.key === "Tab" && open) {
      closeMenu();
    }
  }

  const sizeClasses =
    size === "sm" ? "px-3 py-1.5 text-xs" : "px-3.5 py-2.5 text-sm";
  const displayValue = selected?.label;
  const showPlaceholder = !displayValue;

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={toggleMenu}
        onKeyDown={onKeyDown}
        className={`${TRIGGER_BASE} ${sizeClasses} ${
          open ? "border-[#4FAEB2] ring-2 ring-[#4FAEB2]/20" : ""
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${
            showPlaceholder ? "text-slate-400" : "font-medium text-slate-900"
          }`}
        >
          {displayValue ?? placeholder}
        </span>
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[#4FAEB2] transition-all ${
            open
              ? "rotate-180 bg-[#4FAEB2]/10"
              : "bg-transparent group-hover:bg-[#4FAEB2]/8"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && montado && pos
        ? createPortal(
        <div
          ref={menuRef}
          // z por encima de los modales del ERP (el más alto es z-[200]) y por
          // debajo de la pantalla de carga, que sí debe tapar todo.
          className="fixed z-[300]"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            style={{ maxHeight: pos.maxHeight }}
            className="overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl ring-1 ring-[#4FAEB2]/15"
          >
            {options.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-slate-400">
                Sin opciones
              </li>
            ) : (
              options.map((opt, idx) => {
                const isSelected = opt.value === value;
                const isActive = idx === activeIndex;
                return (
                  <li key={`${opt.value}-${idx}`} role="none">
                    <button
                      type="button"
                      role="option"
                      data-idx={idx}
                      aria-selected={isSelected}
                      disabled={opt.disabled}
                      onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
                      onClick={() => selectByIndex(idx)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        opt.disabled
                          ? "cursor-not-allowed text-slate-300"
                          : isActive
                            ? "bg-[#4FAEB2]/10 text-[#2F6E71]"
                            : isSelected
                              ? "text-[#3F8E91]"
                              : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate ${
                            isSelected ? "font-semibold" : "font-medium"
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.description ? (
                          <span className="mt-0.5 block truncate text-xs text-slate-500">
                            {opt.description}
                          </span>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4 shrink-0 text-[#4FAEB2]"
                        >
                          <path d="M5 12l5 5L20 7" />
                        </svg>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>,
            document.body
          )
        : null}
    </div>
  );
}
