# Smoke test — Módulo Caja por turno (cucinaerp)

Valida la migración `supabase/migrations/20260614120000_modulo_caja_turno_cucinaerp.sql`
y el flujo completo de caja (abrir / mover / vender / cerrar / reportes).

Script: `scripts/smoke-caja-cucinaerp.ts` · Comando: `npm run smoke:caja`

## Qué verifica

- **Estructura DB** (requiere `SMOKE_DB_URL`): tablas `cajas` y `caja_movimientos`,
  columna `ventas.caja_id` (nullable → no rompe históricas), índice único parcial
  "una sola caja abierta", RLS + policies, FK `ventas_caja_id_fkey`, y cuántas
  ventas previas quedaron con `caja_id NULL` (no reasignadas).
- **Endpoints GET**: `/api/caja/abierta`, `/api/caja/historial`, `/api/caja/resumen`.
- **Flujo de escritura** (solo con `RUN_CAJA_SMOKE_WRITE=1`): bloqueo de venta sin
  caja ("Para vender primero tenés que abrir caja"), abrir caja (300.000),
  movimientos ingreso/egreso/retiro, venta de prueba asociada a `caja_id`,
  verificación de `ventas.caja_id`, resumen (efectivo esperado + total vendido +
  que transferencia/tarjeta no suman al efectivo), **caso nocturno** (mueve la
  fecha de la venta a post-medianoche y confirma que sigue en la misma caja por
  `caja_id`), cierre (diferencia 0 con contado = esperado), e historial.

## Seguridad

- **DRY-RUN por defecto.** Sin `RUN_CAJA_SMOKE_WRITE=1` solo hace lecturas.
- Si hay una **caja real abierta**, el modo escritura se **omite** (no toca producción).
- Todo dato de prueba se marca con observación **`SMOKE_TEST_CAJA`**.
- Con `SMOKE_DB_URL`, **autolimpia** sus datos al terminar (venta, ítems, movimientos
  de inventario, movimientos de caja, caja; restaura stock). Sin `SMOKE_DB_URL`,
  imprime el **SQL de rollback** exacto (no hay endpoints de borrado).

## Variables

| Variable | Para qué |
|---|---|
| `SMOKE_BASE_URL` | URL de la app (default `http://localhost:3000`) |
| `SMOKE_EMAIL` / `SMOKE_PASSWORD` | usuario de la empresa cucinaerp (para el JWT) |
| `SMOKE_ACCESS_TOKEN` | alternativa al email/password (JWT ya emitido) |
| `SMOKE_DB_URL` | connection string Postgres (estructura + limpieza + caso nocturno) |
| `RUN_CAJA_SMOKE_WRITE=1` | habilita las escrituras (default dry-run) |

`NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` se leen de `.env.local`.

## Cómo correrlo

### Local — dry-run (solo lecturas)
```bash
SMOKE_EMAIL=usuario@cucinaerp SMOKE_PASSWORD=*** npm run smoke:caja
```

### Local — flujo completo (escritura + autolimpieza)
Requiere un Postgres accesible (DB local o túnel). Levantá la app (`npm run dev`) y:
```bash
RUN_CAJA_SMOKE_WRITE=1 \
SMOKE_DB_URL="postgres://USER:PASS@HOST:5432/postgres" \
SMOKE_EMAIL=usuario@cucinaerp SMOKE_PASSWORD=*** \
npm run smoke:caja
```

### Producción (Coolify / cucinaerp.neura.com.py)
La DB **no expone 5432**: `SMOKE_DB_URL` se arma por **SSH + docker** contra el
contenedor `supabase-db` (mismo canal que las migraciones). Ejecutar el script
desde un shell con ese túnel/forward ya disponible.

- **Dry-run contra prod** (sin tocar nada, recomendado primero):
```bash
SMOKE_BASE_URL=https://cucinaerp.neura.com.py \
SMOKE_EMAIL=usuario@cucinaerp SMOKE_PASSWORD=*** \
npm run smoke:caja
```
- **Escritura contra prod**: solo cuando **no haya caja abierta** (fin de turno).
  Agregá `RUN_CAJA_SMOKE_WRITE=1` y `SMOKE_DB_URL=...` (vía el forward por docker)
  para que autolimpie. Sin `SMOKE_DB_URL`, copiá y ejecutá el SQL de rollback que
  imprime al final.

## Salida

Checklist con `✅ ok` / `❌ fail` / `⚠️ warn` / `⏭️ skip` y un resumen final.
Exit code `1` si hubo algún `❌`.
