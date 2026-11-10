import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCAL_DEVELOPMENT_LIMITS, settingEnvName } from '../settings/index.js';
import { findWorkspaceRoot } from './dotenv.js';
import { CONFIG_ENV_NAMES, isConfigEnvName } from './index.js';

const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
if (!root) throw new Error('workspace root not found');

const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

/** Names assigned in an env file, including commented-out assignments (`# NAME=value`). */
function namesListedIn(content: string): string[] {
  const names = new Set<string>();
  for (const line of content.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

/** Variables Docker Compose interpolates (`${NAME}`, `${NAME:-default}`). */
function composeNames(): Set<string> {
  const names = new Set<string>();
  for (const file of ['docker-compose.yml', 'docker-compose.e2e.yml']) {
    if (!existsSync(path.join(root as string, file))) continue;
    for (const match of read(file).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

/** Variables the web dev server and the e2e runner read from their own environment. */
function webRunnerNames(): Set<string> {
  const files = ['apps/web/vite.config.ts', 'apps/web/playwright.config.ts'];
  const e2e = path.join(root as string, 'apps/web/e2e');
  if (existsSync(e2e)) {
    for (const entry of readdirSync(e2e)) {
      if (entry.endsWith('.ts')) files.push(`apps/web/e2e/${entry}`);
    }
  }
  const names = new Set<string>();
  for (const file of files) {
    if (!existsSync(path.join(root as string, file))) continue;
    for (const match of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

describe('.env.example', () => {
  const listed = namesListedIn(read('.env.example'));

  it('lists every variable the configuration reads', () => {
    const missing = CONFIG_ENV_NAMES.filter((name) => !listed.includes(name));
    expect(missing).toEqual([]);
  });

  it('lists only variables something reads', () => {
    const compose = composeNames();
    const web = webRunnerNames();
    const unread = listed.filter(
      (name) => !isConfigEnvName(name) && !compose.has(name) && !web.has(name),
    );
    expect(unread).toEqual([]);
  });

  it('lists the published Compose ports and the e2e runner variables', () => {
    for (const name of [
      'APP_PORT',
      'DB_PORT',
      'MAILPIT_PORT',
      'STORAGE_PORT',
      'STORAGE_CONSOLE_PORT',
      'HOLIDAY_E2E_BASE_URL',
      'HOLIDAY_E2E_MAILPIT_URL',
    ]) {
      expect(listed).toContain(name);
    }
  });
});

describe('local development limits', () => {
  const names = Object.keys(LOCAL_DEVELOPMENT_LIMITS).map(settingEnvName);

  /** Names the browser-test stack sets on every service (its shared `x-e2e-env` block). */
  function e2eEnvNames(): string[] {
    const compose = read('docker-compose.e2e.yml');
    const start = compose.indexOf('x-e2e-env:');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = compose.slice(start, compose.indexOf('\nservices:', start));
    return [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
  }

  it('are each documented in .env.example', () => {
    const listed = namesListedIn(read('.env.example'));
    expect(names.filter((name) => !listed.includes(name))).toEqual([]);
  });

  it('are each pinned by the browser-test stack, so its runs never depend on the defaults', () => {
    const pinned = e2eEnvNames();
    expect(names.filter((name) => !pinned.includes(name))).toEqual([]);
  });
});

describe('.env.example vendor key conditions', () => {
  const example = read('.env.example').split('\n');
  const development = read('docs/development.md');
  const section = development.slice(development.indexOf('**Before you add a key.**'));
  const conditions = section.slice(0, section.indexOf('\n\n', section.indexOf('- Anthropic')));

  it('points above each image key to the live-mode conditions, stated as the guide states them', () => {
    expect(development).toMatch(/^### Live mode$/m);
    expect(section.length).toBeLessThan(development.length);
    for (const [name, condition] of [
      [
        'OPENAI_API_KEY',
        'an organization with zero data retention enabled for the image endpoints',
      ],
      [
        'GEMINI_API_KEY',
        'a key from a Google AI Studio or Google Cloud project with billing enabled (the paid tier)',
      ],
    ] as const) {
      const index = example.findIndex((line) => line.startsWith(`${name}=`));
      expect(index, name).toBeGreaterThan(0);
      const comment = example[index - 1] ?? '';
      expect(comment, name).toContain('docs/development.md#live-mode');
      expect(comment, name).toContain('Before you add a key');
      expect(comment, name).toContain(condition);
      expect(conditions, name).toContain(condition);
    }
  });
});
