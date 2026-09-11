import type { User } from "@supabase/supabase-js";
import type { UsuarioConEmpresa } from "@/lib/middleware/auth";

/**
 * Construye un `UsuarioConEmpresa` fantasma para uso EXCLUSIVO del worker SIFEN.
 *
 * Este objeto simula el resultado de `getUserAndEmpresa(request)` pero SIN
 * request HTTP: el worker corre en background y no tiene una sesión web.
 *
 * Los handlers extraídos en Fase 1 (`handleSifen*Post`) sólo usan `auth.empresa_id`
 * y ocasionalmente `auth.user?.email` para logging — nunca hacen `auth.getUser()`
 * ni consultan el catálogo. La empresa se resuelve por el `empresa_id` congelado
 * en el `sifen_job` al momento del encolado.
 *
 * Este es el eslabón que garantiza que el worker NO puede resolver otra empresa:
 * `empresa_id` viaja como dato (no como sesión), el service role Supabase filtra
 * por él en cada query.
 */
export function buildAuthSintetico(empresaId: string): UsuarioConEmpresa {
  const bot: User = {
    id: "00000000-0000-0000-0000-000000000000",
    aud: "authenticated",
    role: "service_role",
    email: "sifen-worker@internal.neura",
    app_metadata: { provider: "internal", source: "sifen-worker" },
    user_metadata: { display_name: "SIFEN worker" },
    created_at: new Date(0).toISOString(),
  } as User;

  return {
    user: bot,
    empresa_id: empresaId,
    usuarioCatalogId: null,
  };
}
