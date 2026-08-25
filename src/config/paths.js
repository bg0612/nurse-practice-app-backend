import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configModuleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Filesystem paths owned by the backend package. Keeping these paths relative
 * to backend/ allows the frontend and backend directories to become separate
 * repositories without relying on a shared parent directory.
 */
export const BACKEND_ROOT = path.resolve(configModuleDir, '../..');
export const CONFIG_DIR = path.join(BACKEND_ROOT, 'config');
export const CASES_DIR = path.join(CONFIG_DIR, 'cases');
export const PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');
