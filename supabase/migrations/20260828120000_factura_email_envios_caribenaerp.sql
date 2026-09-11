-- Historial de envíos de la factura por correo.
--
-- Hace falta poder responder "¿al cliente le llegó su factura?" sin depender de
-- la casilla del remitente. El envío se dispara solo cuando la SET aprueba el
-- documento, y también a mano desde el detalle de la factura, así que una
-- misma factura puede tener varios intentos: el automático que falló porque el
-- correo estaba mal escrito, y el reenvío a la dirección corregida.
--
-- Se guardan también los fallos. Un envío que no se registra es un envío que
-- nadie sabe que no ocurrió: el cajero se queda esperando una factura que
-- nunca salió.

BEGIN;

CREATE TABLE IF NOT EXISTS cucinaerp.factura_email_envios (
  id           uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES cucinaerp.empresas(id) ON DELETE CASCADE,
  factura_id   uuid NOT NULL REFERENCES cucinaerp.facturas(id) ON DELETE CASCADE,
  -- A dónde se mandó. Se copia acá porque el correo del cliente puede cambiar
  -- después y el historial tiene que seguir diciendo la dirección real usada.
  destinatario text NOT NULL,
  -- 'automatico' al aprobar el DE, 'manual' desde el botón Reenviar.
  origen       text NOT NULL DEFAULT 'manual',
  ok           boolean NOT NULL,
  -- Id que devolvió el servidor SMTP; sirve para rastrear un envío puntual.
  message_id   text,
  -- Motivo del fallo, tal como lo devolvió el servidor.
  error        text,
  enviado_por  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factura_email_envios_origen_check
    CHECK (origen = ANY (ARRAY['automatico'::text, 'manual'::text]))
);

-- El detalle de la factura muestra el último envío primero.
CREATE INDEX IF NOT EXISTS idx_factura_email_envios_factura
  ON cucinaerp.factura_email_envios (empresa_id, factura_id, created_at DESC);

COMMIT;
