import { NextResponse } from "next/server";
import { getAuthWithRol, isAdmin, type UsuarioConEmpresaYRol } from "@/lib/middleware/auth";

/**
 * Guard para endpoints administrativos que operan con service role.
 *
 * El service role SALTEA RLS: cualquier consulta hecha con esa key ignora las
 * políticas de la base. Por eso, en un endpoint que la usa, la autorización
 * tiene que hacerse acá explícitamente — no hay red de contención debajo.
 *
 * Varios endpoints bajo /api/admin y /api/create-user no tenían NINGUNA
 * comprobación: bastaba conocer la URL para cambiar contraseñas, listar
 * usuarios de Auth o crear cuentas. Este guard cierra esa clase de agujero en
 * un solo lugar.
 */
export type AdminGuardOk = { ok: true; auth: UsuarioConEmpresaYRol };
export type AdminGuardFail = { ok: false; response: NextResponse };

/** Exige sesión válida + rol administrador de empresa. */
export async function requireAdminEmpresa(
  request: Request
): Promise<AdminGuardOk | AdminGuardFail> {
  const auth = await getAuthWithRol(request);
  if (!auth) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }
  if (!isAdmin(auth)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Requiere permisos de administrador" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, auth };
}

/**
 * Verifica que el usuario objetivo pertenezca a la empresa del administrador.
 *
 * Sin esto, un admin de la empresa A podría operar sobre usuarios de la empresa
 * B pasando su UUID: el service role se lo permitiría sin chistar. Devuelve el
 * email del usuario objetivo, que es lo que necesitan estos endpoints.
 */
export async function usuarioDeLaMismaEmpresa(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  usuarioId: string,
  empresaId: string
): Promise<{ ok: true; email: string } | { ok: false; response: NextResponse }> {
  const { data, error } = await supabase
    .from("usuarios")
    .select("id, email, empresa_id")
    .eq("id", usuarioId)
    .maybeSingle();

  // 404 y no 403 a propósito: no confirmarle a quien sondea que el UUID existe
  // en otra empresa.
  if (error || !data || data.empresa_id !== empresaId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 }),
    };
  }
  return { ok: true, email: String(data.email ?? "") };
}
