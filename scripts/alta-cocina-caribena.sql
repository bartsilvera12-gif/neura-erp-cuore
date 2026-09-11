-- Alta del usuario de cocina: ficha en el ERP + acceso SOLO a Comandas.
--
-- Requisito previo: crear cocina@cucinadelcoure.com en Supabase Auth
-- (Authentication → Users → Add user), con contraseña y "Auto Confirm User".
-- Poder iniciar sesión no alcanza: el ERP necesita la ficha en `usuarios` para
-- saber a qué empresa pertenece y con qué rol, y filas en `usuario_modulos`
-- para saber qué puede abrir.
--
-- Rol 'usuario', no 'admin'. Un admin ve todos los módulos activos de la
-- empresa sin importar usuario_modulos; con rol 'usuario' el acceso es la
-- intersección, que es justamente lo que se busca acá.
--
-- Se le da Comandas y nada más. Es la pantalla que va a estar abierta todo el
-- servicio en la PC de cocina, en modo kiosco y sin barra de direcciones: si
-- ese usuario tuviera Ventas o Inventario, cualquiera que pase por la cocina
-- podría cobrar o tocar stock sin dejar rastro de quién fue. Con esto, el
-- servidor lo frena aunque escriba la URL a mano.
--
-- Se puede correr más de una vez sin duplicar nada.

BEGIN;

-- 1) Ficha en el ERP, tomando el id de Auth por email.
INSERT INTO cucinaerp.usuarios (email, nombre, rol, empresa_id, auth_user_id, activo, estado, area)
SELECT au.email,
       'Cocina',
       'usuario',
       (SELECT id FROM cucinaerp.empresas LIMIT 1),
       au.id,
       true,
       'activo',
       'operaciones'
  FROM auth.users au
 WHERE au.email = 'cocina@cucinadelcoure.com'
ON CONFLICT (email) DO UPDATE
   SET auth_user_id = EXCLUDED.auth_user_id,
       empresa_id   = EXCLUDED.empresa_id,
       activo       = true,
       estado       = 'activo';

-- 2) Acceso a Comandas.
INSERT INTO cucinaerp.usuario_modulos (usuario_id, modulo_id)
SELECT u.id, m.id
  FROM cucinaerp.usuarios u
  CROSS JOIN cucinaerp.modulos m
 WHERE u.email = 'cocina@cucinadelcoure.com'
   AND m.slug IN ('comandas')
ON CONFLICT (usuario_id, modulo_id) DO NOTHING;

-- 3) Freno: si el usuario no existía en Auth, los pasos de arriba no insertaron
--    nada y el COMMIT dejaría todo como estaba sin avisar. Mejor que reviente
--    acá que descubrirlo en cocina un viernes a la noche.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cucinaerp.usuarios WHERE email = 'cocina@cucinadelcoure.com') THEN
    RAISE EXCEPTION 'cocina@cucinadelcoure.com no existe en auth.users: crealo primero en Supabase Auth.';
  END IF;
END $$;

COMMIT;

-- Verificación: tiene que salir una fila, rol usuario, módulos = "comandas".
SELECT u.email, u.rol, u.activo, string_agg(m.slug, ', ' ORDER BY m.slug) AS modulos
  FROM cucinaerp.usuarios u
  LEFT JOIN cucinaerp.usuario_modulos um ON um.usuario_id = u.id
  LEFT JOIN cucinaerp.modulos m ON m.id = um.modulo_id
 WHERE u.email = 'cocina@cucinadelcoure.com'
 GROUP BY u.email, u.rol, u.activo;
