import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  FILE_ONLY_ENV_NAMES,
  REFUSED_ENV_NAMES,
  applyEnvFile,
  findWorkspaceRoot,
  loadWorkspaceEnvFile,
} from './dotenv.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(envContent: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'holiday-dotenv-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  if (envContent !== null) writeFileSync(path.join(dir, '.env'), envContent);
  mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
  return dir;
}

describe('applyEnvFile', () => {
  it('fills unset variables from the file and keeps values set in the shell', () => {
    const env: Record<string, string | undefined> = { LOG_LEVEL: 'debug' };
    const result = applyEnvFile(env, 'LOG_LEVEL=info\nPORT=3000\nEMAIL_FROM="Holiday <a@b.c>"\n');
    expect(env).toMatchObject({ LOG_LEVEL: 'debug', PORT: '3000', EMAIL_FROM: 'Holiday <a@b.c>' });
    expect(result.applied.sort()).toEqual(['EMAIL_FROM', 'PORT']);
  });

  it('takes provider keys only from the file, never from the shell', () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: 'sk-from-another-project',
      ANTHROPIC_API_KEY: 'sk-ant-from-shell',
      GOOGLE_MAPS_SERVER_KEY: '',
    };
    const result = applyEnvFile(env, 'ANTHROPIC_API_KEY=sk-ant-from-file\n');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-from-file');
    expect('GOOGLE_MAPS_SERVER_KEY' in env).toBe(false);
    expect(result.dropped.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  });

  it('drops shell provider keys even when there is no file', () => {
    const env: Record<string, string | undefined> = { GEMINI_API_KEY: 'gemini-shell', PORT: '1' };
    expect(applyEnvFile(env, null)).toEqual({
      applied: [],
      dropped: ['GEMINI_API_KEY'],
      refused: [],
    });
    expect(env).toEqual({ PORT: '1' });
  });
});

describe('the provider-key drop rule', () => {
  it('drops every provider key inherited from the shell and lets the file set each one', () => {
    const shell = Object.fromEntries(FILE_ONLY_ENV_NAMES.map((name) => [name, `shell-${name}`]));
    const dropped = { ...shell } as Record<string, string | undefined>;
    expect(applyEnvFile(dropped, '').dropped.sort()).toEqual([...FILE_ONLY_ENV_NAMES].sort());
    for (const name of FILE_ONLY_ENV_NAMES) expect(name in dropped).toBe(false);

    const fromFile = { ...shell } as Record<string, string | undefined>;
    applyEnvFile(fromFile, FILE_ONLY_ENV_NAMES.map((name) => `${name}=file-${name}`).join('\n'));
    for (const name of FILE_ONLY_ENV_NAMES) expect(fromFile[name]).toBe(`file-${name}`);
  });

  it('lets the shell win for every other variable, secrets included', () => {
    const env: Record<string, string | undefined> = {
      SESSION_SECRET: 'shell-session-secret-0123456789abcdef0123',
      TURNSTILE_SECRET_KEY: 'shell-turnstile',
      S3_SECRET_ACCESS_KEY: 'shell-s3',
      IMAGE_EDITOR_PROVIDER: 'fixture',
    };
    const result = applyEnvFile(
      env,
      'SESSION_SECRET=file\nTURNSTILE_SECRET_KEY=file\nS3_SECRET_ACCESS_KEY=file\n' +
        'IMAGE_EDITOR_PROVIDER=openai\nOPENAI_API_KEY=sk-file\n',
    );
    expect(env).toMatchObject({
      SESSION_SECRET: 'shell-session-secret-0123456789abcdef0123',
      TURNSTILE_SECRET_KEY: 'shell-turnstile',
      S3_SECRET_ACCESS_KEY: 'shell-s3',
      IMAGE_EDITOR_PROVIDER: 'fixture',
      OPENAI_API_KEY: 'sk-file',
    });
    expect(result).toEqual({ applied: ['OPENAI_API_KEY'], dropped: [], refused: [] });
  });

  it('is stated in the .env.example header, naming exactly these keys', () => {
    const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
    if (!root) throw new Error('workspace root not found');
    const example = readFileSync(path.join(root, '.env.example'), 'utf8');
    const header = example.slice(0, example.indexOf('\n# ----'));
    const precedence = header.slice(header.indexOf('# Which value wins:'));
    expect(precedence).toContain('wins over this file, EXCEPT the provider keys');
    expect(precedence).toContain("your shell's variables are not passed into them");
    const named = FILE_ONLY_ENV_NAMES.filter((name) => precedence.includes(name));
    expect(named).toEqual([...FILE_ONLY_ENV_NAMES]);
  });
});

describe('the refused vendor redirect variables', () => {
  it('removes them from the shell and never takes them from the file', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_AUTH_TOKEN: 'shell-token',
      ANTHROPIC_CUSTOM_HEADERS: '',
      PORT: '1',
    };
    const result = applyEnvFile(
      env,
      'ANTHROPIC_CUSTOM_HEADERS=X-Forward: yes\nANTHROPIC_BASE_URL=https://file.example\nLOG_LEVEL=info\n',
    );
    expect(env).toEqual({ PORT: '1', LOG_LEVEL: 'info' });
    expect(result.applied).toEqual(['LOG_LEVEL']);
    expect(result.refused.sort()).toEqual([...REFUSED_ENV_NAMES].sort());
    expect(result.dropped).toEqual([]);
  });

  it('is stated in the .env.example header, naming exactly these variables', () => {
    const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
    if (!root) throw new Error('workspace root not found');
    const example = readFileSync(path.join(root, '.env.example'), 'utf8');
    const header = example.slice(0, example.indexOf('\n# ----'));
    const named = REFUSED_ENV_NAMES.filter((name) => header.includes(name));
    expect(named).toEqual([...REFUSED_ENV_NAMES]);
  });
});

describe('loadWorkspaceEnvFile', () => {
  it('finds the workspace root from a nested directory and loads its .env', () => {
    const dir = workspace('APP_VERSION=9.9.9\n');
    const env: Record<string, string | undefined> = {};
    const result = loadWorkspaceEnvFile(env, path.join(dir, 'apps', 'api'));
    expect(result.file).toBe(path.join(dir, '.env'));
    expect(env.APP_VERSION).toBe('9.9.9');
    expect(findWorkspaceRoot(path.join(dir, 'apps', 'api'))).toBe(dir);
  });

  it('continues without a .env file', () => {
    const dir = workspace(null);
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-shell' };
    const result = loadWorkspaceEnvFile(env, path.join(dir, 'apps', 'api'));
    expect(result).toEqual({
      file: null,
      applied: [],
      dropped: ['OPENAI_API_KEY'],
      refused: [],
    });
    expect(env).toEqual({});
  });
});
