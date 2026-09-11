/**
 * Vocabulario visual del ERP.
 *
 * Antes cada pantalla escribía sus propias clases, y por eso convivían botones
 * con seis radios distintos, tablas con cinco grises de cabecera y acciones que
 * a veces eran un link subrayado y a veces un botón. Estas constantes son la
 * versión única de cada pieza: importalas en lugar de volver a escribir la
 * cadena de clases.
 *
 * Regla de color: turquesa = acción principal, blanco con borde = acción
 * secundaria, rojo = destructiva. El color no se usa nunca sólo por adorno.
 */

/** Base común de todos los botones: alto, tipografía, foco accesible. */
const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-xl text-sm font-semibold " +
  "transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[#4FAEB2]/40 " +
  "focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 " +
  "disabled:shadow-none active:translate-y-px";

/** Acción principal de la pantalla. Como mucho una por bloque. */
export const btnPrimario = `${BASE} bg-[#4FAEB2] px-4 py-2.5 text-white hover:bg-[#3F8E91]`;

/** Acción principal de peso, en la paleta oscura (guardar, enviar). */
export const btnOscuro = `${BASE} bg-slate-900 px-4 py-2.5 text-white hover:bg-slate-700`;

/** Acción secundaria: exportar, importar, cancelar, volver. */
export const btnSecundario =
  `${BASE} border border-slate-200 bg-white px-4 py-2.5 text-slate-700 shadow-sm ` +
  "hover:border-[#4FAEB2]/50 hover:bg-slate-50 hover:text-slate-900";

/** Acción destructiva confirmada (borrar de verdad). */
export const btnPeligro = `${BASE} bg-red-600 px-4 py-2.5 text-white hover:bg-red-700`;

/** Acción destructiva de bajo peso: vive dentro de una fila, no grita. */
export const btnPeligroSuave =
  `${BASE} border border-red-200 bg-white px-3 py-2 text-red-600 hover:border-red-300 hover:bg-red-50`;

/** Sin fondo ni borde. Para acciones terciarias dentro de una tarjeta. */
export const btnGhost = `${BASE} px-3 py-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900`;

/** Variante compacta: aplicá sobre cualquiera de los anteriores para filas de tabla. */
export const btnChico = "px-3 py-1.5 text-xs";

/** Botón cuadrado de solo ícono. El texto va en aria-label. */
export const btnIcono =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white " +
  "text-slate-500 shadow-sm transition-all duration-150 outline-none " +
  "hover:border-[#4FAEB2]/50 hover:text-[#3F8E91] focus-visible:ring-2 focus-visible:ring-[#4FAEB2]/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Ícono cuadrado en tono destructivo. */
export const btnIconoPeligro =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white " +
  "text-slate-400 shadow-sm transition-all duration-150 outline-none " +
  "hover:border-red-300 hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-300 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

// ── Superficies ──────────────────────────────────────────────────────────────

/** Tarjeta contenedora. `overflow-hidden` para que la tabla respete el radio. */
export const card =
  "overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm";

/** Cabecera de tarjeta: título a la izquierda, acciones a la derecha. */
export const cardHead =
  "flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 " +
  "bg-gradient-to-b from-slate-50/70 to-white px-5 py-4";

/** Cuerpo con padding estándar (para tarjetas que no llevan tabla). */
export const cardBody = "p-5";

// ── Tablas ───────────────────────────────────────────────────────────────────

export const tabla = "w-full text-left text-sm";
export const thead = "bg-slate-50";
export const thRow =
  "border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
export const th = "px-5 py-3";
export const tbody = "divide-y divide-slate-100";
export const tr = "transition-colors hover:bg-slate-50/70";
export const td = "px-5 py-3.5 text-slate-700";
/** Celda de identidad de la fila (nombre, código): más peso que el resto. */
export const tdFuerte = "px-5 py-3.5 font-medium text-slate-800";

/** Estado vacío dentro de una tabla. Se usa en el <td colSpan>. */
export const celdaVacia = "px-5 py-14 text-center text-sm text-slate-400";

// ── Formularios ──────────────────────────────────────────────────────────────

/** Mismo borde, radio y foco que FancySelect, para que un input y un selector
 *  puestos lado a lado se lean como una sola fila de controles. */
export const input =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 " +
  "shadow-sm outline-none transition-colors placeholder:text-slate-400 " +
  "hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20 " +
  "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

export const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

// ── Badges de estado ─────────────────────────────────────────────────────────

const BADGE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset";

export const badgeOk = `${BADGE} bg-emerald-50 text-emerald-700 ring-emerald-600/15`;
export const badgeNeutro = `${BADGE} bg-slate-100 text-slate-600 ring-slate-500/15`;
export const badgeAviso = `${BADGE} bg-amber-50 text-amber-800 ring-amber-600/15`;
export const badgeError = `${BADGE} bg-red-50 text-red-700 ring-red-600/15`;
export const badgeMarca = `${BADGE} bg-[#4FAEB2]/12 text-[#2F6E71] ring-[#4FAEB2]/25`;

// ── Avisos ───────────────────────────────────────────────────────────────────

export const avisoInfo =
  "rounded-xl border border-[#4FAEB2]/25 bg-[#4FAEB2]/8 px-4 py-3 text-sm text-[#2F6E71]";
export const avisoError =
  "rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700";
