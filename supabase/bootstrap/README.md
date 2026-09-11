# Bootstrap — Neura ERP Cucina del Cuore

Puesta en marcha de la instancia dedicada **Cucina del Cuore** sobre el mismo proyecto
Supabase que ya usa En lo de Mari, con schema propio `cucinaerp`, su propio
`empresa_id` y **sin dependencias hacia `public` ni `zentra_erp`**. No se copian
datos: sólo la estructura.

## Opción rápida

Un solo archivo, una sola transacción:

- **`00_bootstrap_completo.sql`** — hace los 4 pasos de abajo de una. Pegalo
  entero en el SQL Editor de Supabase y dale Run.

## Opción por pasos

Si preferís ir de a uno (o ya tenés el schema creado y sólo querés aislarlo):

| # | Archivo | Qué hace |
|---|---|---|
| 1 | `01_clone_schema_estructura.sql` | Crea `cucinaerp` y clona de `enlodemari` tipos, secuencias, funciones, tablas, constraints, índices, FKs, vistas, triggers, RLS y policies. Sin datos. |
| 2 | `02_aislar.sql` | Corta toda dependencia hacia `public` / `zentra_erp`. Idempotente: si ya está aislado no hace nada. |
| 3 | `03_grants.sql` | Grants a `anon`, `authenticated`, `service_role` + default privileges. |
| 4 | `04_empresa_cucina.sql` | Inserta la empresa con UUID nuevo y le replica los módulos. Imprime el `empresa_id`. |

Corré `02_aislar.sql` **antes** de los grants, para que las funciones que trae
al schema queden cubiertas por ellos.

## Qué hace el aislamiento

`cucinaerp` sale del clon con restos de la etapa multi-tenant: FKs a
`public.empresas`, policies que llaman `public.puede_acceder_empresa()`, triggers
que usan `public.set_updated_at()`. El paso de aislamiento los corta:

1. Clona a `cucinaerp` las funciones de `public`/`zentra_erp` que el schema
   todavía llama y que no tienen gemela local, reescribiendo su cuerpo para que
   lean tablas locales. Es iterativo: una función clonada puede llamar a otra.
2. Reescribe cuerpos de funciones, defaults, check constraints, índices con
   expresión, policies de RLS, triggers y vistas.
3. Repunta las foreign keys a la tabla gemela local.

**Regla de oro**: sólo reescribe `otroschema.objeto` → `cucinaerp.objeto`
cuando `cucinaerp.objeto` **existe**. Si no existe, no inventa nada: deja la
referencia intacta y la lista en el reporte final. Nunca vas a terminar con una
referencia rota.

La **VERIFICACIÓN 4** al final del script lista todo lo que no se pudo aislar,
con el motivo. **Si sale vacía, el aislamiento está completo.**

## Qué queda compartido, y por qué

Por diseño de Supabase, un proyecto tiene una sola instancia de:

- `auth` — los usuarios de Cucina del Cuore viven en el mismo `auth.users` que los de
  En lo de Mari. Se separan por su fila en `cucinaerp.usuarios`.
- `storage` — mismos buckets; los archivos se separan por prefijo `empresa_id`.
- `extensions`, `pg_catalog` — infraestructura, sin datos de negocio.

Para desacoplar **también** eso hace falta un **proyecto Supabase aparte**. En ese
caso el repo no cambia: sólo apuntás `NEXT_PUBLIC_SUPABASE_URL` y las keys al
proyecto nuevo, y corrés el mismo bootstrap usando un dump de `enlodemari` como
origen.

## Después de correr los scripts

1. **Exponer el schema**: Supabase → *Settings → API → Exposed schemas* → agregar
   `cucinaerp`. **Quitá `zentra_erp`** si estaba: esta instancia ya no lo usa.
   Sin exponer `cucinaerp`, PostgREST no lo ve por más grants que haya.
2. **Variables de entorno** (Vercel y `.env.local`):

   ```
   NEURA_CLIENT_SCHEMA=cucinaerp
   NEURA_INSTANCE_MODE=single_client
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   DATABASE_URL=...
   DIRECT_URL=...
   ```

   `NEURA_CLIENT_SCHEMA` es sólo un override: el default del repo ya es
   `cucinaerp` (ver `src/lib/supabase/schema.ts`).
3. **Usuario inicial**: crearlo en Supabase Auth y darle su fila en
   `cucinaerp.usuarios` con el `empresa_id` que imprimió el último paso.

## Rehacer desde cero

```sql
DROP SCHEMA cucinaerp CASCADE;
```

y volver a correr el bootstrap.

## Límites conocidos

- Las **tablas particionadas** se recrean como tabla plana (hoy no hay ninguna en
  `enlodemari`; el script avisa por `NOTICE` si aparece alguna).
- Las opciones de secuencia de columnas `IDENTITY` (start/increment custom) no se
  copian; arrancan con los valores por defecto. Como el schema queda vacío, no
  afecta.
- Los **datos de catálogo** (módulos, roles, estados, menú) no se copian, salvo
  `modulos` + `empresa_modulos` (el catálogo de módulos y su allowlist, que el
  ERP necesita para arrancar). Si querés arrastrar más catálogos, corré las migraciones de seed
  de `supabase/cucinaerp/migrations/`. Esa lectura de `enlodemari` es puntual,
  del bootstrap: no deja ninguna dependencia permanente.
