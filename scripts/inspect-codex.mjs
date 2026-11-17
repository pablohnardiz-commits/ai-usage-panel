#!/usr/bin/env node
// Resume la ESTRUCTURA de los logs de Codex para depurar el parser.
// No imprime contenido (ni código, ni prompts, ni rutas): solo tipos, nombres de herramientas y números.
// Uso: node scripts/inspect-codex.mjs [carpeta-sessions]
import path from 'node:path';
import { codexSessionDirs } from '../src/codex-logs.mjs';
import { listFiles, forEachLine } from '../src/util.mjs';

const dirs = process.argv[2] ? [process.argv[2]] : codexSessionDirs();
const inc = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const top = (m, n = 25) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `    ${v}\t${k}`).join('\n');
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : String(o));

const lineTypes = new Map();
const toolNames = new Map();
const patchWhere = new Map();
const tcShapes = new Map();
const versions = new Map();
const noTokenTypes = new Map();
const noTokenVersions = new Map();
const legacy = new Map();
const seqs = [];
let files = 0;
let bad = 0;
let noTokenFiles = 0;

for (const dir of dirs) {
  for (const file of listFiles(dir, (n) => n.startsWith('rollout-'))) {
    if (!file.endsWith('.jsonl')) {
      inc(legacy, path.extname(file));
      continue;
    }
    files++;
    let version = '?';
    let hasTc = false;
    const types = new Set();
    const seq = [];
    let prev = null;
    forEachLine(file, (raw) => {
      if (raw === null) {
        bad++;
        return;
      }
      if (!raw.trim()) return;
      let o;
      try {
        o = JSON.parse(raw);
      } catch {
        bad++;
        return;
      }
      const p = o.payload;
      const t = `${o.type ?? '(sin type)'}/${p && typeof p === 'object' ? p.type ?? '(sin payload.type)' : o.record_type ?? '-'}`;
      inc(lineTypes, t);
      types.add(t);
      if (o.type === 'session_meta' && p) version = `${p.cli_version ?? '?'} ${p.originator ?? ''}`.trim();
      if (p && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'tool_call')) {
        inc(toolNames, `${p.type}:${p.name ?? '(sin name)'}`);
      }
      if (raw.includes('Begin Patch')) inc(patchWhere, `${t}${p && p.name ? `:${p.name}` : ''} · claves payload: ${keys(p)}`);
      else if (/apply_patch|patch_apply|"changes"/.test(raw)) inc(patchWhere, `(sin "Begin Patch") ${t}${p && p.name ? `:${p.name}` : ''} · claves payload: ${keys(p)}`);
      if (p && p.type === 'token_count') {
        const info = p.info;
        inc(tcShapes, info ? `info{${keys(info)}} total{${keys(info.total_token_usage)}} last{${keys(info.last_token_usage)}}` : `info=${info}`);
        if (info && info.total_token_usage) {
          hasTc = true;
          const tot = info.total_token_usage.total_tokens ?? 0;
          const last = info.last_token_usage ? info.last_token_usage.total_tokens ?? 0 : null;
          seq.push(`${(o.timestamp || '').slice(11, 19)} total=${tot} last=${last} Δtotal=${prev == null ? '-' : tot - prev}`);
          prev = tot;
        }
      }
    });
    inc(versions, version);
    if (!hasTc) {
      noTokenFiles++;
      inc(noTokenVersions, version);
      for (const t of types) inc(noTokenTypes, t);
    } else {
      // Sesiones donde la suma de "last" no coincide con el total final.
      let sumLast = 0;
      let lastTot = 0;
      let mism = false;
      for (const s of seq) {
        const m = s.match(/total=(\d+) last=(\d+|null) Δtotal=(-?\d+|-)/);
        if (m[3] === '0') continue; // token_count repetido: el parser lo salta
        if (m[2] !== 'null') sumLast += Number(m[2]);
        lastTot = Number(m[1]);
        if (m[3] !== '-' && m[2] !== 'null' && Number(m[3]) !== Number(m[2])) mism = true;
      }
      if ((mism || sumLast !== lastTot) && seqs.length < 3) seqs.push({ version, sumLast, lastTot, seq: seq.slice(0, 30) });
    }
  }
}

console.log(`Carpetas: ${dirs.length} · ficheros .jsonl: ${files} · líneas no JSON: ${bad}`);
if (legacy.size) console.log(`Otros ficheros rollout-*: ${[...legacy].map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`\nVersiones de Codex (cli_version originator):\n${top(versions, 15)}`);
console.log(`\nTipos de línea (type/payload.type):\n${top(lineTypes, 40)}`);
console.log(`\nLlamadas a herramientas:\n${top(toolNames, 30) || '    ninguna'}`);
console.log(`\nDónde aparecen los parches:\n${top(patchWhere, 20) || '    en ningún sitio'}`);
console.log(`\nFormas de token_count:\n${top(tcShapes, 10) || '    ninguna'}`);
console.log(`\nFicheros sin token_count: ${noTokenFiles}\n  versiones:\n${top(noTokenVersions, 10)}\n  tipos de línea que tienen:\n${top(noTokenTypes, 15)}`);
for (const s of seqs) {
  console.log(`\nSesión que no cuadra (versión ${s.version}): suma de last=${s.sumLast} · total final=${s.lastTot}`);
  console.log(s.seq.map((x) => `    ${x}`).join('\n'));
}
