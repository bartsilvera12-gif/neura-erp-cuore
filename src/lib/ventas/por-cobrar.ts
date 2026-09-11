import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { MesaDetalle, MesaSesionItem } from "@/lib/mesas/types";

type Ok<T> = { success: true } & T;
type Err = { success: false; error: string };

async function call<T>(url: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<Ok<T> | Err> {
  try {
    const res = await fetchWithSupabaseSession(url, {
      method, cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { success?: boolean; data?: T; error?: string };
    if (!res.ok || !json.success || !json.data) return { success: false, error: json.error ?? `Error (${res.status}).` };
    return { success: true, ...(json.data as T) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Error de red." };
  }
}

/** Detalle de la cuenta por_cobrar (para que caja la edite). */
export async function getSesionPorCobrar(sesionId: string): Promise<MesaDetalle | null> {
  const r = await call<{ detalle: MesaDetalle }>(`/api/ventas/mesas-por-cobrar/${encodeURIComponent(sesionId)}`, "GET");
  return r.success ? r.detalle : null;
}

export function agregarItemCaja(
  sesionId: string,
  payload: {
    producto_id: string; cantidad: number; observacion: string | null; precio_unitario?: number | null;
    display_name?: string;
    mitad?: { producto1_id: string; producto2_id: string; nombre1: string; nombre2: string };
  }
) {
  return call<{ item: MesaSesionItem }>(`/api/ventas/mesas-por-cobrar/${encodeURIComponent(sesionId)}/items`, "POST", payload);
}

export function actualizarItemCaja(itemId: string, payload: { cantidad?: number; cancelar?: boolean }) {
  return call<{ item: MesaSesionItem }>(`/api/ventas/mesas-por-cobrar/items/${encodeURIComponent(itemId)}`, "PATCH", payload);
}
