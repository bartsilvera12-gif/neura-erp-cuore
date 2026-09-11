-- Avisos de modificación y cancelación a cocina, e historial de cambios.
--
-- Agregar productos a una mesa ya enviada y mandar sólo lo nuevo ya funcionaba:
-- cada envío arma su propia comanda con los ítems pendientes. Lo que faltaba es
-- lo que pasa cuando se toca algo que YA está en cocina.
--
-- Hoy, si el mozo cancela o corrige una pizza ya enviada, el cocinero sigue con
-- el papel viejo y nadie le avisa: sigue preparando algo que ya no se pidió.
-- Por eso una comanda pasa a poder ser de tres tipos, y las dos nuevas llevan
-- el detalle del cambio adentro — no tienen ítems propios porque no son un
-- pedido, son un mensaje sobre un pedido que ya salió.

BEGIN;

-- ── Tipo de comanda ───────────────────────────────────────────────────────
ALTER TABLE cucinaerp.comandas
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'pedido',
  -- Qué cambió, para las de modificación y cancelación.
  ADD COLUMN IF NOT EXISTS detalle jsonb,
  -- true cuando la mesa ya tenía comandas: cocina tiene que ver que esto se
  -- suma a lo que ya está preparando, no que lo reemplaza.
  ADD COLUMN IF NOT EXISTS es_agregado boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comandas_tipo_check'
      AND conrelid = 'cucinaerp.comandas'::regclass
  ) THEN
    ALTER TABLE cucinaerp.comandas
      ADD CONSTRAINT comandas_tipo_check
      CHECK (tipo = ANY (ARRAY['pedido'::text, 'modificacion'::text, 'cancelacion'::text]));
  END IF;
END $$;

-- ── Historial de cambios del pedido ───────────────────────────────────────
-- Quién tocó qué y cuándo. Va en su propia tabla y no en la línea del pedido
-- porque una línea puede cambiar varias veces, y lo que se quiere revisar
-- después es la secuencia completa, no el último estado.
CREATE TABLE IF NOT EXISTS cucinaerp.mesa_sesion_item_historial (
  id             uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES cucinaerp.empresas(id) ON DELETE CASCADE,
  sesion_id      uuid NOT NULL REFERENCES cucinaerp.mesa_sesiones(id) ON DELETE CASCADE,
  -- Se conserva el registro aunque la línea desaparezca: es justamente el caso
  -- que alguien va a querer auditar.
  item_id        uuid REFERENCES cucinaerp.mesa_sesion_items(id) ON DELETE SET NULL,
  accion         text NOT NULL,
  /** Frase lista para leer: "Cambió PIZZA MARGARITA por PIZZA PEPPERONI". */
  descripcion    text NOT NULL,
  detalle        jsonb,
  /** true si el cambio se hizo sobre algo que ya estaba en cocina. */
  ya_enviado     boolean NOT NULL DEFAULT false,
  usuario_id     uuid REFERENCES cucinaerp.usuarios(id) ON DELETE SET NULL,
  usuario_nombre text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mesa_sesion_item_historial_accion_check
    CHECK (accion = ANY (ARRAY['agregado'::text, 'cantidad'::text, 'producto'::text,
                               'observacion'::text, 'cancelado'::text]))
);

CREATE INDEX IF NOT EXISTS idx_msi_historial_sesion
  ON cucinaerp.mesa_sesion_item_historial (empresa_id, sesion_id, created_at DESC);

COMMIT;
