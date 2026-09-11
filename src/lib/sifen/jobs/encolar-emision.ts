/**
 * Pone a emitir un documento electrónico sin esperar a que nadie abra la
 * pantalla.
 *
 * Hasta ahora la emisión arrancaba cuando el panel de la factura terminaba de
 * cargar y pedía encolar. Entre confirmar la venta, la navegación y el montaje
 * de la pantalla se perdían varios segundos con el cliente esperando, y daba la
 * sensación de que el trámite empezaba de nuevo después de cobrar.
 *
 * Llamando esto apenas se crea la factura, el worker ya está armando el XML
 * mientras el navegador todavía está cambiando de página.
 *
 * Nunca lanza: el cobro ya ocurrió y la factura ya existe. Si el encolado
 * falla, el panel lo intenta de nuevo al montarse, que es el comportamiento de
 * siempre.
 */
import { handleSifenBorradorPost } from "@/lib/sifen/handle-sifen-borrador-post";
import { enqueueSifenJob } from "@/lib/sifen/jobs/sifen-jobs-repo";
import type { UsuarioConEmpresa } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import type { FacturaElectronicaDTO } from "@/lib/sifen/types";
import type { NextRequest } from "next/server";

export interface EncolarEmisionResult {
  encolado: boolean;
  motivo?: string;
}

export async function encolarEmisionSifen(
  request: NextRequest,
  facturaId: string,
  auth: UsuarioConEmpresa,
  supabase: AppSupabaseClient
): Promise<EncolarEmisionResult> {
  try {
    // Mismo handler que usa el endpoint de encolar: asegura el borrador y es
    // idempotente si ya existía.
    const res = await handleSifenBorradorPost(
      request,
      Promise.resolve({ id: facturaId }),
      auth,
      supabase
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { encolado: false, motivo: body.error ?? `borrador ${res.status}` };
    }
    const json = (await res.json()) as { success?: boolean; data?: FacturaElectronicaDTO };
    const fe = json.data;
    if (!json.success || !fe) return { encolado: false, motivo: "borrador sin datos" };

    const st = String(fe.estado_sifen ?? "");
    if (st === "aprobado" || st === "cancelado") {
      return { encolado: false, motivo: `documento ya ${st}` };
    }

    const enq = await enqueueSifenJob(supabase, {
      empresaId: auth.empresa_id,
      facturaId,
      facturaElectronicaId: fe.id,
      origen: "auto_venta",
    });
    if (!enq.ok) return { encolado: false, motivo: enq.message };

    return { encolado: true };
  } catch (e) {
    return { encolado: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}
