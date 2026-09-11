import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { ConciliacionFiltros, ConciliacionResumen, ConciliacionRow, CuentaBancaria } from "./types";

export async function getCuentasBancarias(): Promise<CuentaBancaria[]> {
  try {
    const res = await fetchWithSupabaseSession("/api/cuentas-bancarias", { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; data?: { cuentas: CuentaBancaria[] } };
    return json?.data?.cuentas ?? [];
  } catch { return []; }
}

export async function getConciliacion(f?: ConciliacionFiltros): Promise<{ items: ConciliacionRow[]; resumen: ConciliacionResumen | null; cuentas: CuentaBancaria[] }> {
  const qs = new URLSearchParams();
  if (f?.desde) qs.set("desde", f.desde);
  if (f?.hasta) qs.set("hasta", f.hasta);
  if (f?.estado) qs.set("estado", f.estado);
  if (f?.medio_pago) qs.set("medio_pago", f.medio_pago);
  if (f?.cuenta_bancaria_id) qs.set("cuenta_bancaria_id", f.cuenta_bancaria_id);
  if (f?.caja_id) qs.set("caja_id", f.caja_id);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    const res = await fetchWithSupabaseSession(`/api/reportes/conciliacion${suffix}`, { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; data?: { items: ConciliacionRow[]; resumen: ConciliacionResumen; cuentas: CuentaBancaria[] } };
    if (!json?.success || !json.data) return { items: [], resumen: null, cuentas: [] };
    return json.data;
  } catch { return { items: [], resumen: null, cuentas: [] }; }
}

type Res = { success: true; conciliacion: ConciliacionRow } | { success: false; error: string };
async function post(id: string, accion: "aprobar" | "rechazar", motivo?: string): Promise<Res> {
  try {
    const res = await fetchWithSupabaseSession(`/api/reportes/conciliacion/${encodeURIComponent(id)}/${accion}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(motivo ? { motivo } : {}),
    });
    const json = (await res.json()) as { success?: boolean; data?: { conciliacion: ConciliacionRow }; error?: string };
    if (!res.ok || !json.success || !json.data) return { success: false, error: json.error ?? `Error (${res.status}).` };
    return { success: true, conciliacion: json.data.conciliacion };
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : "Error de red." }; }
}
export const aprobarConciliacion = (id: string) => post(id, "aprobar");
export const rechazarConciliacion = (id: string, motivo: string) => post(id, "rechazar", motivo);
