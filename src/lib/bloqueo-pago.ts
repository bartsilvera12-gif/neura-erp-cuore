/**
 * Bloqueo del ERP por falta de pago.
 *
 * Con `true`, el middleware manda TODA la navegación del ERP (incluido /login) a
 * /bloqueado, que muestra el aviso de falta de pago, y las rutas /api/* responden 402.
 * Los webhooks (/api/webhooks/*) quedan fuera del middleware y siguen recibiendo.
 * El sitio público (SITIO_HOST_REGEX) no se toca.
 *
 * PARA DESBLOQUEAR: poner `false`, commit + push a main y esperar el redeploy de Coolify.
 * No hay que tocar nada más (ni base, ni usuarios, ni variables de entorno).
 */
export const ERP_BLOQUEADO_POR_FALTA_DE_PAGO = true;

export const BLOQUEO_PAGO_PATH = "/bloqueado";

export const BLOQUEO_PAGO_MENSAJE =
  "El acceso al sistema está suspendido por falta de pago. Para reactivarlo, comunicate con Neura.";
