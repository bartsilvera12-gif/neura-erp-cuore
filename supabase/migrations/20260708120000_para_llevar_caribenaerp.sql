-- =============================================================================
-- Módulo MESAS — soporte "Para llevar" / Retiro (SOLO schema `cucinaerp`).
--
-- Extiende mesa_sesiones para representar pedidos sin mesa asignada:
--   · tipo ('mesa'|'para_llevar')  · mesa_id nullable  · nombre_cliente
--   · numero_pl (correlativo por empresa, secuencia dedicada, arranca en 1,
--     nunca resetea)
--
-- El resto del flujo (ítems, comandas, cobro) queda idéntico. La única
-- diferencia es que un pedido PL no ocupa mesa: al facturar/cerrar NO se toca
-- estado de mesa (no hay mesa_id).
--
-- Idempotente. Reversible (rollback abajo en comentario).
-- =============================================================================

DO $$
DECLARE
  sch text := 'cucinaerp';
BEGIN
  IF to_regclass(format('%I.mesa_sesiones', sch)) IS NULL THEN
    RAISE NOTICE '[para_llevar] schema % sin mesa_sesiones; se omite.', sch;
    RETURN;
  END IF;

  -- ── 1) mesa_sesiones: nuevas columnas ────────────────────────────────────
  EXECUTE format('ALTER TABLE %I.mesa_sesiones ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT ''mesa''', sch);
  EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP CONSTRAINT IF EXISTS mesa_sesiones_tipo_check', sch);
  EXECUTE format($c$ALTER TABLE %I.mesa_sesiones ADD CONSTRAINT mesa_sesiones_tipo_check CHECK (tipo IN ('mesa','para_llevar'))$c$, sch);

  EXECUTE format('ALTER TABLE %I.mesa_sesiones ADD COLUMN IF NOT EXISTS nombre_cliente text', sch);
  EXECUTE format('ALTER TABLE %I.mesa_sesiones ADD COLUMN IF NOT EXISTS numero_pl integer', sch);

  -- mesa_id: pasa a nullable (una sesión PL no tiene mesa).
  EXECUTE format('ALTER TABLE %I.mesa_sesiones ALTER COLUMN mesa_id DROP NOT NULL', sch);

  -- Consistencia: tipo='mesa' ⇒ mesa_id NOT NULL; tipo='para_llevar' ⇒ mesa_id NULL.
  EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP CONSTRAINT IF EXISTS mesa_sesiones_tipo_mesa_id_check', sch);
  EXECUTE format($c$
    ALTER TABLE %I.mesa_sesiones ADD CONSTRAINT mesa_sesiones_tipo_mesa_id_check CHECK (
      (tipo = 'mesa' AND mesa_id IS NOT NULL) OR
      (tipo = 'para_llevar' AND mesa_id IS NULL)
    )
  $c$, sch);

  -- Correlativo PL único por empresa (para sesiones PL).
  EXECUTE format($ix$CREATE UNIQUE INDEX IF NOT EXISTS uq_mesa_ses_pl_numero ON %I.mesa_sesiones (empresa_id, numero_pl) WHERE tipo = 'para_llevar' AND numero_pl IS NOT NULL$ix$, sch);

  -- El índice viejo uq_mesa_ses_viva (una sesión viva por mesa) SIGUE VÁLIDO:
  -- filtra por mesa_id, y en PL mesa_id es NULL (Postgres no considera NULL
  -- para UNIQUE), así que múltiples PL simultáneos ya están permitidos.

  -- ── 2) Secuencia de correlativo PL por empresa ───────────────────────────
  IF to_regclass(format('%I.para_llevar_correlativo', sch)) IS NULL THEN
    EXECUTE format($ddl$
      CREATE TABLE %I.para_llevar_correlativo (
        empresa_id uuid PRIMARY KEY REFERENCES %I.empresas(id) ON DELETE CASCADE,
        ultimo integer NOT NULL DEFAULT 0
      )
    $ddl$, sch, sch);

    EXECUTE format('ALTER TABLE %I.para_llevar_correlativo ENABLE ROW LEVEL SECURITY', sch);
    EXECUTE format('DROP POLICY IF EXISTS pl_corr_select ON %I.para_llevar_correlativo', sch);
    EXECUTE format('CREATE POLICY pl_corr_select ON %I.para_llevar_correlativo FOR SELECT USING (%I.puede_acceder_empresa(empresa_id))', sch, sch);
    EXECUTE format('DROP POLICY IF EXISTS pl_corr_insert ON %I.para_llevar_correlativo', sch);
    EXECUTE format('CREATE POLICY pl_corr_insert ON %I.para_llevar_correlativo FOR INSERT WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch);
    EXECUTE format('DROP POLICY IF EXISTS pl_corr_update ON %I.para_llevar_correlativo', sch);
    EXECUTE format('CREATE POLICY pl_corr_update ON %I.para_llevar_correlativo FOR UPDATE USING (%I.puede_acceder_empresa(empresa_id)) WITH CHECK (%I.puede_acceder_empresa(empresa_id))', sch, sch, sch);
  END IF;

  -- Función para obtener el siguiente correlativo (atómica, arranca en 1).
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION %I.next_para_llevar_numero(p_empresa_id uuid)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %I, pg_temp
    AS $body$
    DECLARE
      v_next integer;
    BEGIN
      INSERT INTO %I.para_llevar_correlativo (empresa_id, ultimo)
      VALUES (p_empresa_id, 1)
      ON CONFLICT (empresa_id) DO UPDATE
        SET ultimo = %I.para_llevar_correlativo.ultimo + 1
      RETURNING ultimo INTO v_next;
      RETURN v_next;
    END;
    $body$;
  $fn$, sch, sch, sch, sch);

  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.next_para_llevar_numero(uuid) TO authenticated, anon, service_role', sch);

  RAISE NOTICE '[para_llevar] columnas + secuencia + función aplicadas en %.', sch;
END $$;

-- =============================================================================
-- ROLLBACK (copiar/pegar en Supabase si hay que deshacer):
-- -----------------------------------------------------------------------------
-- DO $$
-- DECLARE sch text := 'cucinaerp';
-- BEGIN
--   -- Bloquear rollback si hay sesiones PL vivas (evita corrupción de datos).
--   IF EXISTS (SELECT 1 FROM cucinaerp.mesa_sesiones WHERE tipo = 'para_llevar') THEN
--     RAISE EXCEPTION 'Existen sesiones PL. Cerralas o migrálas antes del rollback.';
--   END IF;
--   EXECUTE format('DROP FUNCTION IF EXISTS %I.next_para_llevar_numero(uuid)', sch);
--   EXECUTE format('DROP TABLE IF EXISTS %I.para_llevar_correlativo', sch);
--   EXECUTE format('DROP INDEX IF EXISTS %I.uq_mesa_ses_pl_numero', sch);
--   EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP CONSTRAINT IF EXISTS mesa_sesiones_tipo_mesa_id_check', sch);
--   EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP CONSTRAINT IF EXISTS mesa_sesiones_tipo_check', sch);
--   EXECUTE format('ALTER TABLE %I.mesa_sesiones ALTER COLUMN mesa_id SET NOT NULL', sch);
--   EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP COLUMN IF EXISTS numero_pl', sch);
--   EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP COLUMN IF EXISTS nombre_cliente', sch);
--   EXECUTE format('ALTER TABLE %I.mesa_sesiones DROP COLUMN IF EXISTS tipo', sch);
-- END $$;
-- =============================================================================
