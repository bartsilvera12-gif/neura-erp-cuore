/**
 * Envío de correo por SMTP.
 *
 * Se usa SMTP y no un proveedor de API (Resend, Brevo) porque la casilla del
 * remitente ya existe y está hosteada: no hace falta contratar nada ni tocar
 * DNS, y el dominio ya tiene sus registros de envío configurados por el hosting.
 *
 * La configuración va por variables de entorno y no en la base porque son
 * credenciales: no deben poder leerse desde la aplicación ni quedar en un
 * respaldo de datos.
 *
 *   SMTP_HOST      smtp.hostinger.com
 *   SMTP_PORT      465
 *   SMTP_USER      info@neura.com.py
 *   SMTP_PASSWORD  (contraseña de la casilla)
 *   SMTP_FROM      "Nombre visible <info@neura.com.py>"  (opcional)
 *
 * Si falta cualquiera de las obligatorias, `mailConfigurado()` devuelve false y
 * quien llama decide qué hacer. Nunca se lanza una excepción por falta de
 * configuración: que no haya correo no puede impedir emitir una factura.
 */
import nodemailer from "nodemailer";

export interface AdjuntoMail {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EnviarMailInput {
  para: string;
  asunto: string;
  html: string;
  /** Alternativa en texto plano para clientes que no muestran HTML. */
  texto?: string;
  adjuntos?: AdjuntoMail[];
}

export interface EnviarMailResult {
  ok: boolean;
  /** Id que devuelve el servidor, útil para rastrear un envío puntual. */
  messageId?: string;
  message: string;
}

function leerConfig() {
  const host = (process.env.SMTP_HOST ?? "").trim();
  const user = (process.env.SMTP_USER ?? "").trim();
  const password = process.env.SMTP_PASSWORD ?? "";
  const puerto = Number((process.env.SMTP_PORT ?? "465").trim()) || 465;
  const from = (process.env.SMTP_FROM ?? "").trim() || user;
  return { host, user, password, puerto, from };
}

/** true si hay con qué mandar. Se consulta antes de ofrecer el botón de envío. */
export function mailConfigurado(): boolean {
  const c = leerConfig();
  return !!(c.host && c.user && c.password);
}

export async function enviarMail(input: EnviarMailInput): Promise<EnviarMailResult> {
  const c = leerConfig();
  if (!c.host || !c.user || !c.password) {
    return {
      ok: false,
      message: "El envío de correo no está configurado (faltan las variables SMTP).",
    };
  }

  const destino = input.para.trim();
  if (!destino) return { ok: false, message: "No hay dirección de destino." };

  try {
    const transporte = nodemailer.createTransport({
      host: c.host,
      port: c.puerto,
      // 465 es SSL directo; el resto de los puertos negocian TLS con STARTTLS.
      secure: c.puerto === 465,
      auth: { user: c.user, pass: c.password },
    });

    const info = await transporte.sendMail({
      from: c.from,
      to: destino,
      subject: input.asunto,
      html: input.html,
      text: input.texto,
      attachments: input.adjuntos,
    });

    return { ok: true, messageId: info.messageId, message: `Enviado a ${destino}.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // El detalle sirve para diagnosticar (credenciales, puerto, casilla
    // inexistente) y por eso se devuelve en vez de tragarse el error.
    console.error("[mail] fallo el envio", { host: c.host, puerto: c.puerto, msg });
    return { ok: false, message: `No se pudo enviar: ${msg}` };
  }
}
