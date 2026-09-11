-- Descuentos en el cobro, autorizados con una clave.
--
-- Un descuento es plata que se deja de cobrar, así que no puede quedar en manos
-- de cualquiera que esté frente a la caja ni desaparecer sin rastro. Dos cosas:
--
--   1) Una clave por empresa para autorizarlo. Se guarda HASHEADA con bcrypt
--      (pgcrypto), nunca en claro: quien lea la base no puede aplicar
--      descuentos, y si la base se filtra la clave no viaja con ella.
--
--   2) El descuento queda escrito en la venta —cuánto, por qué y quién lo
--      autorizó—. Sin eso, al cierre del turno la caja no cuadra y no hay forma
--      de saber si faltó dinero o si alguien hizo un descuento legítimo.
--
-- El descuento NO se guarda sólo como un total: al crear la venta se reparte
-- entre las líneas, así el IVA, la factura electrónica y el KUDE siguen
-- cuadrando solos. Estas columnas son el registro de que hubo descuento y de
-- cuánto fue, para el arqueo y los reportes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS cucinaerp.empresa_descuento_config (
  empresa_id     uuid PRIMARY KEY REFERENCES cucinaerp.empresas(id) ON DELETE CASCADE,
  -- bcrypt. Nulo = no hay clave cargada y entonces no se puede descontar.
  clave_hash     text,
  -- Techo de seguridad: un descuento del 100% sería regalar la venta entera.
  max_porcentaje numeric NOT NULL DEFAULT 100,
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT empresa_descuento_max_check
    CHECK (max_porcentaje > 0 AND max_porcentaje <= 100)
);

ALTER TABLE cucinaerp.ventas
  ADD COLUMN IF NOT EXISTS descuento numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS descuento_motivo text,
  ADD COLUMN IF NOT EXISTS descuento_autorizado_por uuid;

-- Un descuento negativo sería un recargo encubierto.
ALTER TABLE cucinaerp.ventas
  DROP CONSTRAINT IF EXISTS ventas_descuento_check;
ALTER TABLE cucinaerp.ventas
  ADD CONSTRAINT ventas_descuento_check CHECK (descuento >= 0);

-- Los reportes preguntan "¿cuánto se descontó?", no "¿esta venta tuvo
-- descuento?": el índice sólo cubre las que sí lo tuvieron.
CREATE INDEX IF NOT EXISTS idx_ventas_con_descuento
  ON cucinaerp.ventas (empresa_id, fecha DESC)
  WHERE descuento > 0;

COMMIT;
