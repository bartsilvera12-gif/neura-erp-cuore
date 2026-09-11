/**
 * Traduce mensajes crudos de SET a texto accionable para el operador.
 *
 * SET devuelve códigos + descripciones cortas y técnicas ("RUC del emisor no
 * está habilitado para utilizar este tipo de servicio"). En la práctica esas
 * frases confunden porque el "problema" puede estar en el emisor o en el
 * receptor según el contexto (B2B vs B2C, RUC inscripto o no, etc.).
 *
 * Este helper detecta patrones conocidos y devuelve un texto con:
 *  - Qué significa el error en criollo.
 *  - Qué pasos concretos puede hacer el operador (consultar RUC en SET,
 *    destildar contribuyente, avisar al contador, etc.).
 *
 * Si el mensaje no matchea ningún patrón conocido, se devuelve el original.
 * No toca reglas fiscales ni el XML — solo mejora la copy que ve el usuario.
 */

export interface FriendlyErrorInput {
  raw: string;
  /** Estado sifen actual, opcional para dar contexto en la copy. */
  estadoSifen?: string | null;
}

export interface FriendlyErrorOutput {
  /** Título breve (≤ 80 chars) que resume el problema. */
  titulo: string;
  /** Detalle largo (multi-línea) con contexto y pasos concretos. */
  detalle: string;
  /** Código SET que gatilló el match, si aplica. */
  codigo: string | null;
  /** true si detectamos el error y estamos dando una guía en criollo. */
  reconocido: boolean;
}

/** Detecta el patrón `0301 [1264]` (RUC emisor no habilitado). Cubre las dos causas
 *  reales que vimos en producción:
 *   - El emisor no tiene B2C habilitado en Marangatu y el receptor es sin RUC → B2C.
 *   - El receptor tiene formato de RUC pero no está inscripto en la SET → B2B rebota. */
function esRucNoHabilitado(raw: string): boolean {
  const t = raw.toLowerCase();
  const codigoMatch = /0301/.test(raw) && /1264/.test(raw);
  const textoMatch =
    t.includes("ruc del emisor") ||
    t.includes("no está habilitado") ||
    t.includes("no esta habilitado") ||
    t.includes("tipo de servicio");
  return codigoMatch || (textoMatch && t.includes("emisor"));
}

/** 0160: dRucRec inválido. SET rechaza el formato del RUC (longitud, prefijo, etc.). */
function esRucRecInvalido(raw: string): boolean {
  return /0160/.test(raw) || /drucrec\s*(es\s*)?inv[aá]lido/i.test(raw);
}

/** 0362 [1330]: número de casa del receptor obligatorio. Ya resuelto por código;
 *  si vuelve a aparecer, sospechar de XML viejo cacheado o rama no cubierta.
 *  Chequeamos el sub-código [1330] para no confundir con 0362 [1001] (CDC duplicado). */
function esNumCasaFaltante(raw: string): boolean {
  const t = raw.toLowerCase();
  if (/1330/.test(raw)) return true;
  return /n[uú]mero de casa/i.test(raw) && !t.includes("cdc");
}

/** 0362 [1001]: CDC duplicado. Ocurre cuando el mismo CDC se envía dos veces a SET.
 *  Suele pasar al regenerar desde `error_envio` sin bumpear sifen_regeneracion_seq
 *  (bug del backend, ver handle-sifen-xml-post.ts). Solución para el usuario:
 *  cambiar algo del DE (por ej. destildar/tildar "es contribuyente" y volver a
 *  regenerar) para forzar otro CDC. */
function esCdcDuplicado(raw: string): boolean {
  const t = raw.toLowerCase();
  return /1001/.test(raw) || /cdc\s*duplicado/i.test(t);
}

export function friendlyErrorMsg(input: FriendlyErrorInput): FriendlyErrorOutput {
  const raw = (input.raw ?? "").trim();
  if (!raw) {
    return {
      titulo: "Falló el envío al SET.",
      detalle: "Podés reintentar. Si el error persiste, consultá los detalles del lote.",
      codigo: null,
      reconocido: false,
    };
  }

  if (esRucNoHabilitado(raw)) {
    return {
      titulo: "SET rechazó el envío: el RUC del emisor o del receptor no está habilitado para esta operación.",
      detalle: [
        "Este error puede tener tres causas:",
        "",
        "1) TRANSITORIO DE SET (probá reintentar primero). En la práctica, este mismo error a veces se resuelve solo al reintentar — SET tiene ventanas de validación intermitente o cachés desactualizadas. El sistema ya reintenta una vez automáticamente a los 30 segundos; si el segundo intento también falla, seguí con las causas de abajo.",
        "",
        "2) El receptor no está inscripto como contribuyente en la SET. Aunque en el ERP figure como «es contribuyente», si su RUC no existe en el padrón oficial, la SET rechaza el envío como B2B. Verificalo en https://www.set.gov.py → Consultas rápidas → Consulta de RUC.",
        "   → Si aparece «no encontrado» o «inactivo»: destildá «Es contribuyente» en la ficha del cliente, guardá y regenerá el documento para emitirlo como consumidor final (B2C).",
        "",
        "3) El emisor no tiene habilitada la operación B2C (consumidor final) en Marangatu. Si el receptor es realmente consumidor final, avisá al contador de la empresa emisora para que active la habilitación en el portal SET.",
        "",
        "Mientras se resuelve, podés emitir una nota de remisión desde la venta (documento no fiscal).",
      ].join("\n"),
      codigo: "0301 [1264]",
      reconocido: true,
    };
  }

  if (esRucRecInvalido(raw)) {
    return {
      titulo: "SET rechazó el envío: el RUC del receptor tiene formato inválido.",
      detalle: [
        "Verificá en la ficha del cliente que el RUC esté cargado como «cuerpo-DV» (ej. 2431868-0), sin puntos ni espacios y con solo dígitos.",
        "Si el cliente es una persona física y su RUC no está inscripto, destildá «Es contribuyente» y emití como B2C (consumidor final).",
      ].join("\n"),
      codigo: "0160",
      reconocido: true,
    };
  }

  if (esCdcDuplicado(raw)) {
    return {
      titulo: "SET rechazó el envío: el CDC ya fue usado en un envío anterior.",
      detalle: [
        "El CDC (Código de Control) es único por documento. La SET lo rechaza porque un envío anterior ya lo usó (aunque haya fallado).",
        "",
        "Pasos:",
        "1) Modificá algo del DE — por ejemplo, tildá/destildá «Es contribuyente» en la ficha del cliente, o cambiá el nombre de facturación (podés dejarlo igual después) — y guardá.",
        "2) Volvé a «Regenerar documento» para que el sistema calcule un CDC nuevo.",
        "3) Firmá y enviá otra vez.",
      ].join("\n"),
      codigo: "0362 [1001]",
      reconocido: true,
    };
  }

  if (esNumCasaFaltante(raw)) {
    return {
      titulo: "SET rechazó el envío: falta el número de casa del receptor.",
      detalle: [
        "Este error debería estar resuelto por código; si vuelve a aparecer, probablemente el XML es de una emisión vieja cacheada.",
        "Regenerá el documento (botón «Regenerar documento») para forzar un XML nuevo con el número de casa por default.",
      ].join("\n"),
      codigo: "0362 [1330]",
      reconocido: true,
    };
  }

  return {
    titulo: raw.length > 140 ? `${raw.slice(0, 140)}…` : raw,
    detalle: raw,
    codigo: null,
    reconocido: false,
  };
}
