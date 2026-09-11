import type { User } from "@supabase/supabase-js";
import { resolveApiAuthContext } from "@/lib/middleware/api-auth-context";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { resolveEffectiveModules } from "@/lib/modulos/resolve-effective-modules";

/**
 * Autorización por MÓDULO a nivel servidor (no alcanza con ocultar el sidebar).
 *
 * `slugs` = módulos EFECTIVOS del usuario (misma resolución que el sidebar:
 * super_admin → catálogo; admin/administrador → empresa_modulos activos;
 * resto → empresa_modulos ∩ usuario_modulos). Así un rol acotado (ej. `mozo`,
 * solo `mesas`) no puede operar endpoints de otros módulos por URL directa.
 */
export interface ModuleAuth {
  user: User;
  /** Mismo nombre que `getUserAndEmpresa` para ser drop-in en los handlers. */
  empresa_id: string;
  usuarioCatalogId: string | null;
  rol: string;
  slugs: Set<string>;
}

export async function resolveModuleAuth(request?: Request | null): Promise<ModuleAuth | null> {
  const r = await resolveApiAuthContext(request);
  if (!r.ok || !r.ctx.empresa_id) return null;
  const rol = (r.ctx.usuarioRol ?? "").trim();
  const sb = createServiceRoleClient();
  const modulos = await resolveEffectiveModules(sb, {
    id: r.ctx.usuarioCatalogId ?? "",
    empresa_id: r.ctx.empresa_id,
    rol,
  });
  return {
    user: r.ctx.user,
    empresa_id: r.ctx.empresa_id,
    usuarioCatalogId: r.ctx.usuarioCatalogId ?? null,
    rol,
    slugs: new Set(modulos.map((m) => m.slug).filter(Boolean)),
  };
}

export type RequireModuleResult =
  | { ok: true; auth: ModuleAuth }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Exige que el usuario tenga acceso efectivo al módulo `slug`.
 * 401 si no hay sesión; 403 si está autenticado pero el módulo no le corresponde.
 */
export async function requireModule(request: Request | null | undefined, slug: string): Promise<RequireModuleResult> {
  const auth = await resolveModuleAuth(request);
  if (!auth) return { ok: false, status: 401, error: "No autenticado." };
  if (!auth.slugs.has(slug)) {
    return { ok: false, status: 403, error: "No tenés acceso a este módulo." };
  }
  return { ok: true, auth };
}
