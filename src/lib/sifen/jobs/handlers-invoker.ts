import { NextRequest, NextResponse } from "next/server";
import type { UsuarioConEmpresa } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { handleSifenXmlPost } from "@/lib/sifen/handle-sifen-xml-post";
import { handleSifenFirmarPost } from "@/lib/sifen/handle-sifen-firmar-post";
import { handleSifenEnviarPost } from "@/lib/sifen/handle-sifen-enviar-post";
import { handleSifenConsultaLotePost } from "@/lib/sifen/handle-sifen-consulta-lote-post";
import type {
  FacturaElectronicaDTO,
  SifenXmlGeneracionResponseData,
  SifenFirmarResponseData,
  SifenEnviarTestResponseData,
  SifenConsultaLoteTestResponseData,
} from "@/lib/sifen/types";

/**
 * Puente entre el worker headless y los handlers HTTP-shape ya extraídos en
 * Fase 1. Los handlers reciben `(request, params, auth, supabase, opts)` y
 * devuelven `NextResponse`; el worker los invoca con:
 *   - Un `NextRequest` sintético construido a partir de una URL loopback.
 *     Los handlers sólo lo usan para leer `?debug=1` — no hacen fetch ni
 *     leen headers de sesión (auth se pasa por parámetro).
 *   - Un `params` que resuelve a `{ id: facturaId }`.
 *   - El `auth` sintético (`buildAuthSintetico`) + Supabase service role.
 * Luego lee el `NextResponse` como JSON y lo mapea a un `HandlerResult`.
 *
 * IMPORTANTE: No hay HTTP real. No hay red. No hay cookies. No hay Bearer.
 * `NextRequest` acá es sólo un contenedor tipado para pasar `debug=1` si
 * hiciera falta (no lo hacemos desde el worker — logs completos siempre).
 */

export type HandlerResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

function fakeRequest(): NextRequest {
  // La URL no importa: los handlers sólo usan `request.nextUrl.searchParams`
  // para leer flags de debug. Origen loopback estándar.
  return new NextRequest("http://sifen-worker.internal/invoke");
}

function fakeParams(facturaId: string): Promise<{ id: string }> {
  return Promise.resolve({ id: facturaId });
}

async function readResponse<T>(res: NextResponse): Promise<HandlerResult<T>> {
  const status = res.status;
  let body: { success?: boolean; data?: T; error?: string } = {};
  try {
    body = (await res.json()) as { success?: boolean; data?: T; error?: string };
  } catch {
    body = {};
  }
  if (status >= 200 && status < 300 && body.success && body.data !== undefined) {
    return { ok: true, status, data: body.data };
  }
  return {
    ok: false,
    status,
    error: body.error ?? `HTTP ${status}`,
  };
}

export async function invokeSifenXml(
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient,
  facturaId: string
): Promise<HandlerResult<SifenXmlGeneracionResponseData>> {
  const res = await handleSifenXmlPost(fakeRequest(), fakeParams(facturaId), auth, supabase);
  return readResponse<SifenXmlGeneracionResponseData>(res);
}

export async function invokeSifenFirmar(
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient,
  facturaId: string
): Promise<HandlerResult<SifenFirmarResponseData>> {
  const res = await handleSifenFirmarPost(fakeRequest(), fakeParams(facturaId), auth, supabase);
  return readResponse<SifenFirmarResponseData>(res);
}

export async function invokeSifenEnviar(
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient,
  facturaId: string
): Promise<HandlerResult<SifenEnviarTestResponseData>> {
  const res = await handleSifenEnviarPost(fakeRequest(), fakeParams(facturaId), auth, supabase, {
    soloAmbienteTest: false,
  });
  return readResponse<SifenEnviarTestResponseData>(res);
}

export async function invokeSifenConsultaLote(
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient,
  facturaId: string
): Promise<HandlerResult<SifenConsultaLoteTestResponseData>> {
  const res = await handleSifenConsultaLotePost(fakeRequest(), fakeParams(facturaId), auth, supabase, {
    soloAmbienteTest: false,
  });
  return readResponse<SifenConsultaLoteTestResponseData>(res);
}

/** Utilidad para lectura del estado_sifen actual (para idempotencia). */
export function extraerEstadoSifen(fe: FacturaElectronicaDTO | null | undefined): string {
  return fe?.estado_sifen == null ? "" : String(fe.estado_sifen);
}
