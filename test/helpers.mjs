process.env.TZ = 'UTC';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const CLAUDE_DIR = path.join(FIX, 'claude', 'projects');
export const CODEX_DIR = path.join(FIX, 'codex', 'sessions');
