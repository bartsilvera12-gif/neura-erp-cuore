import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Entidad bancaria del catálogo (banco / POS / billetera / QR / otro). */
export interface EntidadBancaria {
  id: string;
  nombre: string;
  banco: string | null;
  numero_cuenta: string | null;
  tipo: string | null;
  moneda: string;
  activo: boolean;
}

export type EntidadBancariaInput = {
  nombre: string;
  banco?: string | null;
  numero_cuenta?: string | null;
  tipo?: string | null;
  moneda?: string | null;
};

const BASE = "/api/configuracion/entidades-bancarias";

export async function getEntidadesBancarias(todas = false): Promise<EntidadBancaria[]> {
  try {
    const res = await fetchWithSupabaseSession(`${BASE}${todas ? "?todas=1" : ""}`, { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; data?: { entidades?: EntidadBancaria[] } };
    return json?.data?.entidades ?? [];
  } catch { return []; }
}

type Res = { success: true; entidad: EntidadBancaria } | { success: false; error: string };
async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<Res> {
  try {
    const res = await fetchWithSupabaseSession(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { success?: boolean; data?: { entidad: EntidadBancaria }; error?: string };
    if (!res.ok || !json.success || !json.data) return { success: false, error: json.error ?? `Error (${res.status}).` };
    return { success: true, entidad: json.data.entidad };
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : "Error de red." }; }
}

export const crearEntidadBancaria = (input: EntidadBancariaInput) => send(BASE, "POST", input);
export const actualizarEntidadBancaria = (id: string, input: Partial<EntidadBancariaInput> & { activo?: boolean }) =>
  send(`${BASE}/${encodeURIComponent(id)}`, "PATCH", input);

export async function eliminarEntidadBancaria(id: string): Promise<{ success: true; eliminada: boolean; desactivada: boolean } | { success: false; error: string }> {
  try {
    const res = await fetchWithSupabaseSession(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
    const json = (await res.json()) as { success?: boolean; data?: { eliminada: boolean; desactivada: boolean }; error?: string };
    if (!res.ok || !json.success || !json.data) return { success: false, error: json.error ?? `Error (${res.status}).` };
    return { success: true, ...json.data };
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : "Error de red." }; }
}
