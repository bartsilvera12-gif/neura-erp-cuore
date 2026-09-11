-- =============================================================================
-- Neura ERP — Cucina del Cuore
-- FIX: el costeo de recetas ignoraba la unidad del insumo.
--
-- Síntoma: cargar "100 g" de un queso que cuesta Gs. 50.000 el KILO daba un
-- subcosto de Gs. 5.000.000. Correcto: Gs. 5.000.
--
-- Causa: `fn_receta_costeo` multiplicaba directo
--     cantidad × (1 + merma) × productos.costo_promedio
-- pero `cantidad` está en la unidad de la LÍNEA de receta (g) y
-- `costo_promedio` está por unidad del PRODUCTO (kg). Nunca convertía entre
-- las dos. El mismo error afectaba a "unidades posibles", que dividía el stock
-- en kg por una cantidad en g.
--
-- Arreglo: se agrega `fn_factor_unidad(desde, hasta)` con las equivalencias de
-- masa y volumen, y el costeo convierte la cantidad a la unidad del producto
-- antes de multiplicar.
--
-- Si las unidades no son convertibles entre sí (p. ej. UNIDAD vs KG) el factor
-- es 1, que es el comportamiento actual: no se inventa una conversión que no
-- existe. Esos casos salen marcados en `unidad_convertida = false` para poder
-- detectarlos desde la UI.
--
-- Idempotente. Correr en el SQL Editor.
-- =============================================================================

BEGIN;

/**
 * Cuántas unidades `hasta` equivalen a 1 unidad `desde`.
 *   fn_factor_unidad('G','KG')  = 0.001   → 100 g son 0,1 kg
 *   fn_factor_unidad('KG','G')  = 1000
 *   fn_factor_unidad('G','G')   = 1
 *   fn_factor_unidad('UNIDAD','KG') = 1   (no convertible: se deja como está)
 */
CREATE OR REPLACE FUNCTION cucinaerp.fn_factor_unidad(p_desde text, p_hasta text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'cucinaerp', 'public'
AS $$
DECLARE
  d text := upper(btrim(coalesce(p_desde, '')));
  h text := upper(btrim(coalesce(p_hasta, '')));
  fd numeric;
  fh numeric;
  familia_d text;
  familia_h text;
BEGIN
  IF d = '' OR h = '' OR d = h THEN
    RETURN 1;
  END IF;

  -- Masa, expresada en gramos.
  IF d IN ('KG','KILO','KILOS','KILOGRAMO','KILOGRAMOS') THEN familia_d := 'MASA'; fd := 1000;
  ELSIF d IN ('G','GR','GRAMO','GRAMOS')                 THEN familia_d := 'MASA'; fd := 1;
  ELSIF d IN ('MG','MILIGRAMO','MILIGRAMOS')             THEN familia_d := 'MASA'; fd := 0.001;
  -- Volumen, expresado en mililitros.
  ELSIF d IN ('LT','L','LITRO','LITROS')                 THEN familia_d := 'VOL';  fd := 1000;
  ELSIF d IN ('ML','MILILITRO','MILILITROS')             THEN familia_d := 'VOL';  fd := 1;
  ELSE familia_d := NULL;
  END IF;

  IF h IN ('KG','KILO','KILOS','KILOGRAMO','KILOGRAMOS') THEN familia_h := 'MASA'; fh := 1000;
  ELSIF h IN ('G','GR','GRAMO','GRAMOS')                 THEN familia_h := 'MASA'; fh := 1;
  ELSIF h IN ('MG','MILIGRAMO','MILIGRAMOS')             THEN familia_h := 'MASA'; fh := 0.001;
  ELSIF h IN ('LT','L','LITRO','LITROS')                 THEN familia_h := 'VOL';  fh := 1000;
  ELSIF h IN ('ML','MILILITRO','MILILITROS')             THEN familia_h := 'VOL';  fh := 1;
  ELSE familia_h := NULL;
  END IF;

  -- Sin familia común no hay conversión posible: se deja la cantidad como está.
  IF familia_d IS NULL OR familia_h IS NULL OR familia_d <> familia_h THEN
    RETURN 1;
  END IF;

  RETURN fd / fh;
END
$$;

COMMENT ON FUNCTION cucinaerp.fn_factor_unidad(text, text) IS
  'Factor para pasar una cantidad de la unidad `desde` a la unidad `hasta`. 1 si no son convertibles.';


CREATE OR REPLACE FUNCTION cucinaerp.fn_receta_costeo(p_receta_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'cucinaerp', 'public'
AS $function$
DECLARE
  v_costo_total       numeric := 0;
  v_precio_venta      numeric := 0;
  v_rendimiento       numeric := 1;
  v_unidades_posibles numeric;
  v_items             jsonb;
  v_producto_id       uuid;
BEGIN
  SELECT r.producto_id, COALESCE(r.rendimiento_cantidad, 1), COALESCE(p.precio_venta, 0)
    INTO v_producto_id, v_rendimiento, v_precio_venta
  FROM cucinaerp.recetas r
  JOIN cucinaerp.productos p ON p.id = r.producto_id
  WHERE r.id = p_receta_id;

  IF v_producto_id IS NULL THEN
    RETURN jsonb_build_object('error', 'receta_no_encontrada');
  END IF;

  WITH item_calc AS (
    SELECT
      ri.id,
      ri.insumo_producto_id,
      pi.nombre AS insumo_nombre,
      ri.cantidad,
      ri.unidad_medida,
      ri.merma_pct,
      pi.costo_promedio,
      pi.stock_actual,
      pi.unidad_medida AS unidad_producto,
      -- Factor de la unidad de la línea a la unidad del producto.
      cucinaerp.fn_factor_unidad(COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida) AS factor,
      -- Cantidad en la unidad de la LÍNEA (lo que ve el cocinero).
      (ri.cantidad * (1 + ri.merma_pct)) AS cantidad_efectiva,
      -- Cantidad en la unidad del PRODUCTO: la que se puede costear y descontar.
      (ri.cantidad * (1 + ri.merma_pct)
        * cucinaerp.fn_factor_unidad(COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida)
      ) AS cantidad_en_unidad_producto,
      (ri.cantidad * (1 + ri.merma_pct)
        * cucinaerp.fn_factor_unidad(COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida)
        * COALESCE(pi.costo_promedio, 0)
      ) AS subcosto,
      CASE
        WHEN ri.cantidad * (1 + ri.merma_pct)
             * cucinaerp.fn_factor_unidad(COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida) > 0
        THEN FLOOR(
               COALESCE(pi.stock_actual, 0)
               / (ri.cantidad * (1 + ri.merma_pct)
                  * cucinaerp.fn_factor_unidad(COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida))
             )
        ELSE NULL
      END AS unidades_aporte,
      -- false cuando las unidades no eran convertibles y se costeó sin ajustar.
      (COALESCE(upper(btrim(ri.unidad_medida)), upper(btrim(pi.unidad_medida))) = upper(btrim(pi.unidad_medida))
        OR cucinaerp.fn_factor_unidad(COALESCE(ri.unidad_medida, pi.unidad_medida), pi.unidad_medida) <> 1
      ) AS unidad_convertida
    FROM cucinaerp.receta_items ri
    JOIN cucinaerp.productos pi ON pi.id = ri.insumo_producto_id
    WHERE ri.receta_id = p_receta_id
    ORDER BY ri.orden, pi.nombre
  )
  SELECT
    COALESCE(SUM(subcosto), 0),
    COALESCE(MIN(unidades_aporte), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'item_id', id,
      'insumo_producto_id', insumo_producto_id,
      'insumo_nombre', insumo_nombre,
      'cantidad', cantidad,
      'unidad_medida', unidad_medida,
      'unidad_producto', unidad_producto,
      'factor_unidad', factor,
      'cantidad_en_unidad_producto', cantidad_en_unidad_producto,
      'unidad_convertida', unidad_convertida,
      'merma_pct', merma_pct,
      'costo_promedio', costo_promedio,
      'stock_actual', stock_actual,
      'subcosto', subcosto,
      'unidades_aporte', unidades_aporte
    )), '[]'::jsonb)
    INTO v_costo_total, v_unidades_posibles, v_items
  FROM item_calc;

  RETURN jsonb_build_object(
    'receta_id', p_receta_id,
    'costo_total', v_costo_total,
    'costo_unitario', CASE WHEN v_rendimiento > 0 THEN v_costo_total / v_rendimiento ELSE NULL END,
    'precio_venta', v_precio_venta,
    'margen_abs', v_precio_venta - CASE WHEN v_rendimiento > 0 THEN v_costo_total / v_rendimiento ELSE 0 END,
    'margen_pct', CASE
      WHEN v_precio_venta > 0 AND v_rendimiento > 0
      THEN ((v_precio_venta - (v_costo_total / v_rendimiento)) / v_precio_venta) * 100
      ELSE NULL
    END,
    'unidades_posibles', v_unidades_posibles,
    'items', v_items
  );
END
$function$;

COMMIT;

-- ── Verificación ─────────────────────────────────────────────────────────────
SELECT cucinaerp.fn_factor_unidad('G','KG')  AS g_a_kg_esperado_0_001,
       cucinaerp.fn_factor_unidad('KG','G')  AS kg_a_g_esperado_1000,
       cucinaerp.fn_factor_unidad('G','G')   AS igual_esperado_1,
       cucinaerp.fn_factor_unidad('ML','LT') AS ml_a_lt_esperado_0_001,
       cucinaerp.fn_factor_unidad('UNIDAD','KG') AS no_convertible_esperado_1;

-- 100 g de un insumo a Gs. 50.000/KG debe dar 5.000:
SELECT 100 * cucinaerp.fn_factor_unidad('G','KG') * 50000 AS subcosto_esperado_5000;
