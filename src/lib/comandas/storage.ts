import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { ComandaCard, ComandaHistorialFiltros, EstadoComanda } from "./types";

export async function getComandas(estado?: EstadoComanda | null): Promise<ComandaCard[]> {
  try {
    const qs = estado ? `?estado=${encodeURIComponent(estado)}` : "";
    const res = await fetchWithSupabaseSession(`/api/comandas${qs}`, { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; data?: { comandas: ComandaCard[] }; error?: string };
    if (!res.ok || !json.success) return [];
    return json.data?.comandas ?? [];
  } catch {
    return [];
  }
}

/** Historial de comandas impresas/canceladas con filtros. */
export async function getComandasHistorial(f?: ComandaHistorialFiltros): Promise<ComandaCard[]> {
  try {
    const qs = new URLSearchParams();
    if (f?.desde) qs.set("desde", f.desde);
    if (f?.hasta) qs.set("hasta", f.hasta);
    if (f?.estado) qs.set("estado", f.estado);
    if (f?.mesa != null) qs.set("mesa", String(f.mesa));
    if (f?.mozo) qs.set("mozo", f.mozo);
    if (f?.numero != null) qs.set("numero", String(f.numero));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await fetchWithSupabaseSession(`/api/comandas/historial${suffix}`, { cache: "no-store" });
    const json = (await res.json()) as { success?: boolean; data?: { comandas: ComandaCard[] }; error?: string };
    if (!res.ok || !json.success) return [];
    return json.data?.comandas ?? [];
  } catch {
    return [];
  }
}

type Res = { success: true; comanda: ComandaCard } | { success: false; error: string };

async function postComanda(id: string, accion: "imprimir" | "reimprimir" | "cancelar"): Promise<Res> {
  try {
    const res = await fetchWithSupabaseSession(`/api/comandas/${encodeURIComponent(id)}/${accion}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const json = (await res.json()) as { success?: boolean; data?: { comanda: ComandaCard }; error?: string };
    if (!res.ok || !json.success || !json.data) return { success: false, error: json.error ?? `Error (${res.status}).` };
    return { success: true, comanda: json.data.comanda };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Error de red." };
  }
}

/** Registra impresión (print_count++, estado=impresa). */
export const imprimirComanda = (id: string) => postComanda(id, "imprimir");
/** Registra reimpresión (print_count++). */
export const reimprimirComanda = (id: string) => postComanda(id, "reimprimir");
/** Cancela el ticket de comanda. */
export const cancelarComanda = (id: string) => postComanda(id, "cancelar");

/** URL del ticket imprimible (HTML, sin precio, auto-print). */
/**
 * Ticket de cocina listo para imprimir.
 *
 * Va con `auto=1`: se llega acá desde el botón "Imprimir", así que abrir la
 * ventana y esperar un segundo clic no agrega nada — sólo hace perder tiempo en
 * cocina. Con Chrome en `--kiosk-printing` esto sale directo al papel.
 */
export const comandaPrintUrl = (id: string) => `/api/comandas/${encodeURIComponent(id)}/print?auto=1`;

/**
 * Varias comandas en UN solo papel, y por lo tanto en un solo trabajo de
 * impresión.
 *
 * Un pedido con pizza y hamburguesa genera dos comandas, una por sector. Salen
 * una atrás de la otra, separadas por corte, sin que nadie apriete nada entre
 * medio.
 */
export const comandasPrintUrl = (ids: string[]) =>
  `/api/comandas/print?auto=1&ids=${ids.map(encodeURIComponent).join(",")}`;
