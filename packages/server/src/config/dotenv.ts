import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Provider keys that switch a leg to a paid live model when `auto` is selected. Host processes take
 * them only from the repository's `.env`, never from the shell, so a key exported for another
 * project cannot start live calls here.
 */
export const FILE_ONLY_ENV_NAMES = [
  'GOOGLE_MAPS_SERVER_KEY',
  'GOOGLE_STREET_VIEW_BROWSER_KEY',
  'GOOGLE_STREET_VIEW_SIGNING_SECRET',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * Variables the Anthropic SDK reads on its own to redirect requests or add credentials and
 * headers. Hailiday never uses them: the env loader removes them from the shell and ignores them in
 * `.env`, and the configuration refuses to start when one reaches it, so the vision key and
 * customer images can only go to the allowlisted vendor host.
 */
export const REFUSED_ENV_NAMES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;

type MutableEnv = Record<string, string | undefined>;

/** The nearest directory at or above `start` that holds `pnpm-workspace.yaml`, or null. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Applies env-file content to `env`. A variable already set wins, as with Node's `--env-file`,
 * except the provider keys in `FILE_ONLY_ENV_NAMES`: inherited values are removed first, and only
 * the file can set them. The names in `REFUSED_ENV_NAMES` are removed from `env` and never taken
 * from the file. `content` null means there is no file. Returns the names set from the file, the
 * inherited provider keys that were removed, and the refused names that were removed or ignored
 * (names only, never values).
 */
export function applyEnvFile(
  env: MutableEnv,
  content: string | null,
): { applied: string[]; dropped: string[]; refused: string[] } {
  const dropped: string[] = [];
  for (const name of FILE_ONLY_ENV_NAMES) {
    if (env[name] !== undefined) {
      if (env[name] !== '') dropped.push(name);
      delete env[name];
    }
  }
  const refused = new Set<string>();
  const refusedNames: readonly string[] = REFUSED_ENV_NAMES;
  for (const name of refusedNames) {
    if (env[name] !== undefined) {
      if (env[name] !== '') refused.add(name);
      delete env[name];
    }
  }
  const applied: string[] = [];
  if (content !== null) {
    const values = parseEnv(content) as Record<string, string>;
    for (const [name, value] of Object.entries(values)) {
      if (refusedNames.includes(name)) {
        if (value !== '') refused.add(name);
        continue;
      }
      if (env[name] !== undefined) continue;
      env[name] = value;
      applied.push(name);
    }
  }
  return { applied, dropped, refused: [...refused] };
}

/**
 * Loads the workspace root's `.env` (if present) into `env` for a host process started from
 * anywhere inside the repository. Docker containers get the same file through Compose instead.
 */
export function loadWorkspaceEnvFile(
  env: MutableEnv,
  startDir: string,
): { file: string | null; applied: string[]; dropped: string[]; refused: string[] } {
  const root = findWorkspaceRoot(startDir);
  const file = root ? path.join(root, '.env') : null;
  const content = file && existsSync(file) ? readFileSync(file, 'utf8') : null;
  return { file: content === null ? null : file, ...applyEnvFile(env, content) };
}
