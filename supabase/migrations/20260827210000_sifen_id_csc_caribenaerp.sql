-- Guarda el ID del CSC que la SET le asignó a la empresa.
--
-- El hash del QR se calcula sobre la cadena de parámetros más el CSC, y esa
-- cadena incluye `IdCSC`. Hasta ahora el ID se asumía "0001", que es el más
-- común pero no el único: Marangatú permite dos CSC por emisor y el que se
-- entrega puede ser el 0002. Con el ID equivocado el hash no coincide y la SET
-- rechaza el documento con "El hash del código QR incluido el de la cadena de
-- caracteres es inválido", aunque el CSC sea correcto.
--
-- Queda como dato de configuración para poder corregirlo sin un deploy: es un
-- valor que se copia del portal y equivocarse en él no debería costar una
-- release.

BEGIN;

ALTER TABLE cucinaerp.empresa_sifen_config
  ADD COLUMN IF NOT EXISTS id_csc text NOT NULL DEFAULT '0001';

COMMIT;
