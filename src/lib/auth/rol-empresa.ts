/**
 * Comprueba si el `rol` del catálogo (`usuarios` del schema de la instancia) implica
 * acceso a configuración restringida (CRM, facturación, etc.).
 * Comparación case-insensitive por datos históricos o espacios.
 */
export function esRolAdminEmpresaOGlobal(rol: string | null | undefined): boolean {
  const r = (rol ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return (
    r === "admin" ||
    r === "administrador" ||
    r === "super_admin" ||
    r === "super admin" ||
    r === "superadmin"
  );
}
