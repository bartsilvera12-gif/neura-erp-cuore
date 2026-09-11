-- Alta de los tres mozos: ficha en el ERP + acceso a Mesas y Comandas.
--
-- Los usuarios ya existen en Supabase Auth (pueden iniciar sesión), pero eso
-- solo no alcanza: el ERP necesita su ficha en `usuarios` para saber a qué
-- empresa pertenecen y con qué rol, y filas en `usuario_modulos` para saber qué
-- pueden abrir.
--
-- Se les da rol 'usuario', no 'admin'. Un admin ve todos los módulos activos de
-- la empresa sin importar lo que diga usuario_modulos; con rol 'usuario' el
-- acceso es la intersección, que es lo que se busca acá.
--
-- Mesas y Comandas alcanzan para cargar el pedido y mandarlo a cocina. Cobrar y
-- abrir caja exigen el módulo 'ventas', que a propósito NO se les da: el
-- servidor los frena aunque escriban la URL a mano.
--
-- Se puede correr más de una vez sin duplicar nada.

BEGIN;

-- 1) Ficha en el ERP, tomando el id de Auth por email.
INSERT INTO cucinaerp.usuarios (email, nombre, rol, empresa_id, auth_user_id, activo, estado, area)
SELECT au.email,
       initcap(split_part(au.email, '@', 1)),   -- "mozo1" → "Mozo1"
       'usuario',
       (SELECT id FROM cucinaerp.empresas LIMIT 1),
       au.id,
       true,
       'activo',
       'operaciones'
  FROM auth.users au
 WHERE au.email IN ('mozo1@cucinadelcoure.com', 'mozo2@cucinadelcoure.com', 'mozo3@cucinadelcoure.com')
ON CONFLICT (email) DO UPDATE
   SET auth_user_id = EXCLUDED.auth_user_id,
       empresa_id   = EXCLUDED.empresa_id,
       activo       = true,
       estado       = 'activo';

-- 2) Acceso a Mesas y Comandas.
INSERT INTO cucinaerp.usuario_modulos (usuario_id, modulo_id)
SELECT u.id, m.id
  FROM cucinaerp.usuarios u
  CROSS JOIN cucinaerp.modulos m
 WHERE u.email IN ('mozo1@cucinadelcoure.com', 'mozo2@cucinadelcoure.com', 'mozo3@cucinadelcoure.com')
   AND m.slug IN ('mesas', 'comandas')
ON CONFLICT (usuario_id, modulo_id) DO NOTHING;

COMMIT;

-- Verificación: cada mozo tiene que aparecer con "comandas, mesas".
SELECT u.email, u.rol, u.activo, string_agg(m.slug, ', ' ORDER BY m.slug) AS modulos
  FROM cucinaerp.usuarios u
  LEFT JOIN cucinaerp.usuario_modulos um ON um.usuario_id = u.id
  LEFT JOIN cucinaerp.modulos m ON m.id = um.modulo_id
 WHERE u.email LIKE 'mozo%@cucinadelcoure.com'
 GROUP BY u.email, u.rol, u.activo
 ORDER BY u.email;
