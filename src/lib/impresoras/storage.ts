import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { Impresora, SectorImpresora } from "@/lib/impresoras/types";

type Ok<T> = { success: true } & T;
type Err = { success: false; error: string };

async function call<T>(url: string, method: "GET" | "POST", body?: unknown): Promise<Ok<T> | Err> {
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

export function listarImpresoras() {
  return call<{ impresoras: Impresora[] }>("/api/config/impresoras", "GET");
}

export function guardarImpresora(sector: SectorImpresora, ip: string, puerto: number, ancho_mm: 58 | 80 = 80) {
  return call<{ impresora: Impresora }>("/api/config/impresoras", "POST", { sector, ip, puerto, ancho_mm });
}

export function probarImpresora(sector: SectorImpresora, ip?: string, puerto?: number) {
  return call<{ ok: boolean }>("/api/config/impresoras/probar", "POST",
    ip && puerto ? { sector, ip, puerto } : { sector });
}
