import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCAL_DEVELOPMENT_LIMITS, settingEnvName } from '../settings/index.js';
import { findWorkspaceRoot } from './dotenv.js';
import {
  CONFIG_ENV_NAMES,
  DEFAULT_STREET_VIEW_CONTRIBUTOR_IMAGERY,
  isConfigEnvName,
  parseConfig,
} from './index.js';

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

  it('says what turning time-based deletion on deletes at once', () => {
    const lines = read('.env.example').split('\n');
    const at = lines.findIndex((line) => line.startsWith('# RETENTION_TIME_BASED_DELETION='));
    expect(at).toBeGreaterThan(0);
    let start = at;
    // The comment lines right above the variable, up to the previous variable.
    const isComment = (line = '') => line.startsWith('# ') && !/^# [A-Z0-9_]+=/.test(line);
    while (start > 0 && isComment(lines[start - 1])) start -= 1;
    const comment = lines
      .slice(start, at)
      .map((line) => line.slice(2))
      .join(' ');
    expect(comment).toContain('deletes at once every unsaved project idle over 24 hours');
    expect(comment).toContain('or older than 7 days');
    expect(comment).toContain('ends kept sessions older than 7 days');
  });

  it('documents the render job limits at their defaults', () => {
    const lines = read('.env.example').split('\n');
    const defaults = parseConfig({});
    for (const name of [
      'RENDER_HEARTBEAT_S',
      'RENDER_MAX_JOB_DURATION_S',
      'RENDER_REPAIR_BUDGET_S',
    ]) {
      const value = lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
      expect(value, name).toBeDefined();
      expect(parseConfig({ [name]: value }).queue, name).toEqual(defaults.queue);
    }
    expect(defaults.queue.renderMaxJobDurationSeconds).toBe(240);
  });

  it('lists the published Compose ports and the e2e runner variables', () => {
    for (const name of [
      'APP_PORT',
      'DB_PORT',
      'MAILPIT_PORT',
      'STORAGE_PORT',
      'STORAGE_CONSOLE_PORT',
      'HAILIDAY_E2E_BASE_URL',
      'HAILIDAY_E2E_MAILPIT_URL',
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

  it('pin the Street View use policy, contributor imagery and time-based deletion for the browser-test stack', () => {
    const pinned = e2eEnvNames();
    expect(pinned).toEqual(
      expect.arrayContaining([
        'STREET_VIEW_USE_POLICY',
        'STREET_VIEW_CONTRIBUTOR_IMAGERY',
        'RETENTION_TIME_BASED_DELETION',
      ]),
    );
  });

  it('pin the contributor imagery setting of the browser-test stack to its default', () => {
    const compose = read('docker-compose.e2e.yml');
    const pinned = /^\s+STREET_VIEW_CONTRIBUTOR_IMAGERY:\s*(\S+)\s*$/m.exec(compose)?.[1];
    expect(pinned).toBe(DEFAULT_STREET_VIEW_CONTRIBUTOR_IMAGERY);
    expect(read('.env.example')).toMatch(
      new RegExp(
        `^STREET_VIEW_CONTRIBUTOR_IMAGERY=${DEFAULT_STREET_VIEW_CONTRIBUTOR_IMAGERY}$`,
        'm',
      ),
    );
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
