import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findWorkspaceRoot } from './dotenv.js';

const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
if (!root) throw new Error('workspace root not found');

const scripts = (
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

describe('root database scripts', () => {
  it('runs host bucket setup through the .env preload, like db:migrate', () => {
    const script = scripts['db:storage-init'];
    expect(script).toBeDefined();
    expect(script).toContain('--filter @hailiday/server');
    expect(script).toContain('--import ./dist/config/load-env/index.js');
    expect(script).toMatch(/dist\/storage-init\.js$/);
    // The preload and the entry point it names are the server package's build outputs.
    const serverDir = path.join(root, 'packages/server');
    expect(existsSync(path.join(serverDir, 'src/config/load-env/index.ts'))).toBe(true);
    expect(existsSync(path.join(serverDir, 'src/storage-init.ts'))).toBe(true);
  });

  it('keeps every host database script on the server package', () => {
    for (const name of ['db:migrate', 'db:seed', 'db:storage-init']) {
      expect(scripts[name], name).toContain('--filter @hailiday/server');
    }
  });
});
