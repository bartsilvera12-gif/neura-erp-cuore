/** Formato Gs. para reportes (acepta null → "—"). */
export function formatGs(v: number | null | undefined): string {
  if (v == null) return "—";
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}

/** Fecha+hora corta es-PY (acepta null → "—"). */
export function formatFechaHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const METODO_LABEL: Record<string, string> = {
  efectivo: "Efectivo", tarjeta: "Tarjeta", transferencia: "Transferencia",
};
export function metodoPagoLabel(m: string | null | undefined): string {
  return m ? METODO_LABEL[m] ?? m : "—";
}
