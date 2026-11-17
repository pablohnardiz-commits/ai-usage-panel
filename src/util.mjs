// Utilidades compartidas: rutas, lectura de JSONL, fechas y conteo de líneas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';

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

/** Longitud máxima de una línea; por encima, Node no puede crear el texto. */
const MAX_LINE = 400 * 1024 * 1024;

/**
 * Lee un fichero de texto por trozos y llama a `onLine(texto, número)` por cada línea.
 * No carga el fichero entero, así que vale para logs de varios GB.
 * Una línea demasiado larga se informa con `onLine(null, número)`.
 */
export function forEachLine(file, onLine, chunkSize = 4 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = []; // trozos de la línea en curso
  let pendingLen = 0;
  let tooLong = false;
  let lineNo = 0;
  let first = true;
  const emit = (last) => {
    lineNo++;
    if (tooLong) onLine(null, lineNo);
    else {
      let line = pending.length ? pending.join('') + last : last;
      if (first && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line, lineNo);
    }
    first = false;
    pending = [];
    pendingLen = 0;
    tooLong = false;
  };
  const feed = (text) => {
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      const piece = text.slice(start, nl);
      if (!tooLong && pendingLen + piece.length > MAX_LINE) tooLong = true;
      emit(tooLong ? '' : piece);
      start = nl + 1;
    }
    if (start < text.length && !tooLong) {
      const piece = text.slice(start);
      pendingLen += piece.length;
      if (pendingLen > MAX_LINE) {
        tooLong = true;
        pending = [];
      } else pending.push(piece);
    }
  };
  for (const chunk of readChunks(file, chunkSize)) feed(decoder.write(chunk));
  feed(decoder.end());
  if (pending.length || tooLong) emit('');
}

/** Trozos del fichero; los .zst (Codex Desktop comprime las sesiones antiguas) se descomprimen. */
function* readChunks(file, chunkSize) {
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('este Node no sabe leer .zst; actualiza a Node 22.15 o superior');
    }
    const data = zlib.zstdDecompressSync(fs.readFileSync(file));
    for (let i = 0; i < data.length; i += chunkSize) yield data.subarray(i, i + chunkSize);
    return;
  }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(chunkSize);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) yield buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Recorre un JSONL línea a línea. Las líneas vacías se ignoran; las que no son
 * JSON válido se pasan a `onBad` y no detienen la lectura.
 */
export function readJsonl(file, onLine, onBad) {
  let n = 0;
  try {
    forEachLine(file, (raw, lineNo) => {
      if (raw === null) {
        n++;
        onBad({ file, line: lineNo, reason: 'línea demasiado larga' });
        return;
      }
      if (!raw.trim()) return;
      n++;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        onBad({ file, line: lineNo, reason: 'JSON inválido' });
        return;
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        onBad({ file, line: lineNo, reason: 'no es un objeto JSON' });
        return;
      }
      onLine(obj, lineNo);
    });
  } catch (err) {
    onBad({ file, line: 0, reason: `no se pudo leer: ${err.code || err.message}` });
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
