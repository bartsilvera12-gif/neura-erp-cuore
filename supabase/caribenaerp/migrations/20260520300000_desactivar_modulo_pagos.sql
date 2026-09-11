-- =============================================================================
-- Desactivar módulo `pagos` para Cucina del Cuore.
-- Solo schema cucinaerp. Solo empresa Mari. Idempotente.
-- NO toca otros schemas. NO toca otras empresas. NO borra datos.
-- =============================================================================

DO $$
DECLARE
  v_empresa uuid := '56be4586-adb4-4477-a990-8092f1ab0eb1';
  v_modulo_pagos_id uuid;
BEGIN
  SELECT id INTO v_modulo_pagos_id FROM cucinaerp.modulos WHERE slug = 'pagos';

  IF v_modulo_pagos_id IS NULL THEN
    RAISE NOTICE 'Slug "pagos" no existe en cucinaerp.modulos — nada para desactivar.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM cucinaerp.empresa_modulos
    WHERE empresa_id = v_empresa AND modulo_id = v_modulo_pagos_id
  ) THEN
    UPDATE cucinaerp.empresa_modulos SET activo = false
    WHERE empresa_id = v_empresa AND modulo_id = v_modulo_pagos_id;
  ELSE
    INSERT INTO cucinaerp.empresa_modulos (empresa_id, modulo_id, activo)
    VALUES (v_empresa, v_modulo_pagos_id, false);
  END IF;
END $$;
