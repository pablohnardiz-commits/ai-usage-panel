# ai-usage-panel

Panel local que compara tu uso de **Claude Code** y **Codex** a partir de sus logs.
Genera un único fichero HTML con los datos incrustados: sin dependencias, sin red y sin servidor.

Requiere Node 22 o superior.

```bash
node bin/usage-panel.mjs --out panel-uso.html
# opciones
node bin/usage-panel.mjs --out panel-uso.html --since 2026-10-01 --repo ~/code/mi-app --json datos.json
```

| Opción | Qué hace |
|---|---|
| `--out RUTA` | HTML de salida (por defecto `panel-uso.html`) |
| `--since AAAA-MM-DD` | ignora el uso anterior a esa fecha |
| `--repo RUTA` | repo git para contar líneas en commits (se puede repetir) |
| `--json RUTA` | guarda también los datos agregados |
| `--claude-dir RUTA` / `--codex-dir RUTA` | carpetas de logs distintas de las de por defecto |

## De dónde sale cada dato

- **Claude Code** (`~/.claude/projects/**/*.jsonl`, también `~/.config/claude/projects`; respeta `CLAUDE_CONFIG_DIR`).
  - Tokens de las líneas `assistant` (`input`, `cache_creation`, `cache_read`, `output`), con su modelo y `cwd`.
  - Duplicados quitados por `message.id` + `requestId`: el streaming repite el mismo mensaje en varias líneas y las sesiones reanudadas copian el historial. Si las copias difieren, se toma el máximo de cada campo.
  - Líneas escritas estimadas a partir de `Write`, `Edit` y `MultiEdit` (se descartan las líneas comunes al principio y al final, y las ediciones cuyo resultado fue un error). Se ignoran los mensajes `<synthetic>`.
- **Codex** (`~/.codex/sessions/**/rollout-*.jsonl` y `archived_sessions`; respeta `CODEX_HOME`).
  - Tokens sumando `last_token_usage` de cada `token_count`. Los eventos repetidos (mismo total acumulado) se saltan, y la suma se cuadra con `total_token_usage` de cada sesión; las que no cuadran aparecen en «Diagnóstico».
  - `input_tokens` de Codex incluye la parte en caché: el panel la separa como «caché leída». El razonamiento ya va incluido en la salida.
  - Líneas escritas: líneas `+` y `-` de cada `apply_patch` (como herramienta propia o dentro de una llamada a la shell), sin contar los parches que fallaron.
- **Git** (opcional, `--repo`): `git log --all --no-merges --numstat`. Un commit se atribuye a Claude o a Codex por su autor o por las líneas `Co-Authored-By`.

Las líneas de log que no se entienden se cuentan aparte, se muestran en el panel y no detienen el script.
Si no hay logs, se genera un panel vacío con un aviso.

## Qué muestra

Rango de 7, 30 o 90 días o todo; cifras por herramienta (tokens, sesiones, días activos, líneas añadidas y eliminadas, líneas en commits); tokens por día en barras apiladas; líneas escritas por día; reparto por modelo; proyectos con más uso; sesiones recientes; modo claro y oscuro; vista de móvil.

El selector **Con caché / Sin caché** importa: Claude Code relee todo el contexto desde la caché en cada respuesta, así que su total con caché es mucho mayor. Para comparar trabajo nuevo entre las dos herramientas, usa «Sin caché».

No se muestran costes en dólares: con suscripción no se paga por token.

## Pruebas

```bash
npm test                         # node --test con los logs de test/fixtures
node scripts/demo-logs.mjs /tmp/demo
node bin/usage-panel.mjs --claude-dir /tmp/demo/claude/projects --codex-dir /tmp/demo/codex/sessions
```

Para validar con tus datos reales, compara los totales del panel con `/usage` en Claude Code y `/status` en Codex.
