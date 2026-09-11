/**
 * El día, para el local, es el día en Paraguay.
 *
 * La base guarda las fechas como `timestamptz` y la sesión de Postgres corre en
 * UTC. Extraer el día sin convertir devuelve el día UTC, que a partir de las
 * 21:00 de Paraguay ya es el día siguiente. En una lomitería eso es la hora
 * pico: la cena entera se contaba como del día de mañana.
 *
 * Se usa un desplazamiento fijo y NO el nombre 'America/Asuncion', que sería lo
 * habitual. El motivo: Paraguay dejó de cambiar de hora en 2024 y quedó fijo en
 * UTC-3, pero el Postgres de producción tiene la base de zonas horarias vieja y
 * sigue aplicando el horario de verano derogado — entre abril y septiembre
 * responde UTC-4, una hora menos de la real.
 *
 * Eso no es teórico: con el nombre de la zona, una venta de las 00:30 del
 * sábado queda fechada el viernes. El local cierra tarde, así que cae justo en
 * esa franja. El desplazamiento fijo no depende de qué tan actualizado esté el
 * servidor.
 *
 * Vale mientras Paraguay no vuelva a cambiar de hora. Si algún día lo hace,
 * esto tiene que volver a ser el nombre de la zona — y para entonces conviene
 * además poner al día el tzdata del servidor.
 */
export const OFFSET_PARAGUAY = "-03:00";

const AT_TZ = `AT TIME ZONE INTERVAL '${OFFSET_PARAGUAY}'`;

/** Día calendario paraguayo de una columna `timestamptz`, como 'YYYY-MM-DD'. */
export function sqlDiaLocal(columna: string): string {
  return `to_char(${columna} ${AT_TZ}, 'YYYY-MM-DD')`;
}

/** Desde qué instante empieza un día paraguayo dado como 'YYYY-MM-DD'. */
export function sqlDesdeDiaLocal(columna: string, placeholder: string): string {
  return `${columna} >= (${placeholder}::timestamp ${AT_TZ})`;
}

/** Hasta el final del día paraguayo indicado, inclusive. */
export function sqlHastaDiaLocal(columna: string, placeholder: string): string {
  return `${columna} < ((${placeholder}::timestamp + interval '1 day') ${AT_TZ})`;
}
