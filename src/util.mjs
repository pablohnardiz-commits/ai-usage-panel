// Utilidades compartidas: rutas, lectura de JSONL, fechas y conteo de líneas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Lista recursiva de ficheros bajo `root` que cumplen `test(nombre)`. Sin error si no existe. */
export function listFiles(root, test, seen = new Set()) {
  const out = [];
  let real;
  try {
    real = fs.realpathSync(root);
  } catch {
    return out;
  }
  if (seen.has(real)) return out; // evita bucles con enlaces simbólicos
  seen.add(real);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    let isDirectory = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // enlace roto
      }
    }
    if (isDirectory) out.push(...listFiles(full, test, seen));
    else if (isFile && test(e.name)) out.push(full);
  }
  return out.sort();
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recorre un JSONL línea a línea. Las líneas vacías se ignoran; las que no son
 * JSON válido se pasan a `onBad` y no detienen la lectura.
 */
export function readJsonl(file, onLine, onBad) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    onBad({ file, line: 0, reason: `no se pudo leer: ${err.code || err.message}` });
    return 0;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    n++;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      onBad({ file, line: i + 1, reason: 'JSON inválido' });
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      onBad({ file, line: i + 1, reason: 'no es un objeto JSON' });
      continue;
    }
    onLine(obj, i + 1);
  }
  return n;
}

/** Fecha local AAAA-MM-DD de un timestamp ISO, o null si no es válido. */
export function localDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Número de líneas de un texto (sin contar el salto final). */
export function countLines(s) {
  if (typeof s !== 'string' || s === '') return 0;
  const parts = s.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function splitLines(s) {
  if (typeof s !== 'string' || s === '') return [];
  const parts = s.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Estimación de líneas añadidas/eliminadas al sustituir `oldStr` por `newStr`:
 * se descartan las líneas comunes al principio y al final y se cuenta el resto.
 */
export function diffEstimate(oldStr, newStr) {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { added: b.length - p - s, removed: a.length - p - s };
}

/** Nombre de proyecto a partir de un cwd (vale con rutas de Windows y POSIX). */
export function projectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Diagnóstico común por fuente. */
export function newStats() {
  return { dirs: [], files: 0, lines: 0, bad: 0, badSamples: [] };
}

export function addBad(stats, info) {
  stats.bad++;
  if (stats.badSamples.length < 20) stats.badSamples.push(info);
}

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
