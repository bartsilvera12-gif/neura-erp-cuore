import net from "node:net";

/**
 * Adaptador mínimo ESC/POS + envío por TCP a impresora térmica en LAN.
 *
 * No pretende ser una librería completa: cubre lo justo para tickets de
 * cocina y de venta en Cucina del Cuore. El "idioma" ESC/POS es un stream
 * binario con comandos de control (init, negrita, doble tamaño, corte)
 * intercalados con texto. Cada impresora térmica que se precie lo habla.
 *
 * El puerto 9100 (RAW / JetDirect) es el estándar de facto — la impresora
 * recibe los bytes y los procesa directo, sin driver Windows en el medio.
 */

// ── Bytes de control ESC/POS ────────────────────────────────────────────────
const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

/** Inicializa la impresora (borra estilo previo, alinea a izquierda). */
export const CMD_INIT = Buffer.from([ESC, 0x40]);
/** Corta el papel (corte parcial, deja una tira pequeña). */
export const CMD_CORTE = Buffer.from([GS, 0x56, 0x42, 0x00]);
/** Alineación: izquierda / centro / derecha. */
export const CMD_ALIGN_LEFT   = Buffer.from([ESC, 0x61, 0]);
export const CMD_ALIGN_CENTER = Buffer.from([ESC, 0x61, 1]);
export const CMD_ALIGN_RIGHT  = Buffer.from([ESC, 0x61, 2]);
/** Estilo: negrita on/off, doble tamaño on/off. */
export const CMD_BOLD_ON   = Buffer.from([ESC, 0x45, 1]);
export const CMD_BOLD_OFF  = Buffer.from([ESC, 0x45, 0]);
export const CMD_SIZE_2X   = Buffer.from([GS, 0x21, 0x11]); // doble alto + ancho
export const CMD_SIZE_1X   = Buffer.from([GS, 0x21, 0x00]); // normal
/** Salto de línea. */
export const CMD_LF = Buffer.from([LF]);

/**
 * Convierte un string a buffer de bytes usando el codepage que soportan las
 * térmicas económicas chinas (CP437 por defecto). Latin-1 sirve como
 * fallback para acentos básicos y ñ.
 */
export function texto(s: string): Buffer {
  return Buffer.from(s, "latin1");
}

/** Ancho en caracteres para un ancho de papel en mm (font A de 12x24). */
export function anchoCaracteres(anchoMm: 58 | 80): number {
  return anchoMm === 58 ? 32 : 48;
}

/**
 * Envía un buffer de bytes ESC/POS a una impresora TCP.
 * Timeout de conexión: 5s. Timeout de escritura: 5s.
 */
export async function enviarTcp(ip: string, puerto: number, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let finalizado = false;
    const cerrar = (err?: Error) => {
      if (finalizado) return;
      finalizado = true;
      try { socket.destroy(); } catch { /* nada */ }
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => cerrar(new Error(`Timeout conectando a ${ip}:${puerto}`)), 5000);
    socket.once("error", (err) => { clearTimeout(timer); cerrar(err); });
    socket.connect(puerto, ip, () => {
      clearTimeout(timer);
      socket.write(payload, () => {
        // Damos 200ms para que la impresora reciba los bytes y cortemos.
        setTimeout(() => cerrar(), 200);
      });
    });
  });
}

/**
 * Ticket de prueba: sirve para verificar que la config apunta a la impresora
 * correcta. Sale con el nombre del sector bien grande arriba, un texto de
 * verificación, y corta el papel.
 */
export function ticketPrueba(sector: string): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(CMD_INIT);
  chunks.push(CMD_ALIGN_CENTER);
  chunks.push(CMD_SIZE_2X);
  chunks.push(CMD_BOLD_ON);
  chunks.push(texto("CUCINA DEL COURE"));
  chunks.push(CMD_LF);
  chunks.push(CMD_SIZE_1X);
  chunks.push(texto(`PRUEBA - ${sector.toUpperCase()}`));
  chunks.push(CMD_LF);
  chunks.push(CMD_BOLD_OFF);
  chunks.push(CMD_ALIGN_LEFT);
  chunks.push(texto("─".repeat(32)));
  chunks.push(CMD_LF);
  chunks.push(texto("Si estas leyendo esto, la"));
  chunks.push(CMD_LF);
  chunks.push(texto("impresora esta bien conectada."));
  chunks.push(CMD_LF);
  chunks.push(texto("─".repeat(32)));
  chunks.push(CMD_LF);
  chunks.push(texto(new Date().toLocaleString("es-PY")));
  chunks.push(CMD_LF);
  chunks.push(CMD_LF);
  chunks.push(CMD_LF);
  chunks.push(CMD_CORTE);
  return Buffer.concat(chunks);
}
