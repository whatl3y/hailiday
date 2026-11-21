import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { findWorkspaceRoot } from './dotenv.js';

const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
if (!root) throw new Error('workspace root not found');

const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const DOCKERFILES = [
  'deploy/Dockerfile.heroku.web',
  'deploy/Dockerfile.heroku.worker',
  'deploy/Dockerfile.heroku.release',
];

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.e2e.yml'];

/** An image reference that names a tag and pins it by digest (`[registry/]name:tag@sha256:<hex>`). */
const DIGEST_PINNED =
  /^(?:[^\s@/]+\/)*[^\s@/:]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[0-9a-f]{64}$/;

/** Anything in an instruction that could fetch or install pnpm. */
const PNPM_SOURCE = /\bnp[mx]\b|\bcorepack\b|\bpnpm@|\bpnpm-\d|get\.pnpm\.io/i;

/** Lifecycle scripts that run when a workspace project is installed. */
const INSTALL_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'pnpm:devPreinstall',
];

/** The pnpm version and hex sha512 that `packageManager` in the root package.json pins. */
function pinnedPnpm(): { version: string; sha512: string } {
  const { packageManager } = JSON.parse(read('package.json')) as { packageManager?: string };
  const match = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(packageManager ?? '');
  if (!match?.[1] || !match[2])
    throw new Error(`packageManager is not pinned by sha512: ${packageManager}`);
  return { version: match[1], sha512: match[2] };
}

/** A Dockerfile's instructions as Docker reads them: comment lines dropped, continuations joined. */
function instructions(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/[ \t]*\\\n[ \t]*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The parser directives (`# syntax=`, `# escape=`, `# check=`) at the top of a Dockerfile. */
function parserDirectives(content: string): string[] {
  const directives: string[] = [];
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (!/^#\s*(?:syntax|escape|check)\s*=/i.test(line)) break;
    directives.push(line.trim());
  }
  return directives;
}

/** The base images and `COPY --from` images of a Dockerfile, without references to its own stages. */
function dockerfileImages(content: string): string[] {
  const stages = new Set<string>();
  const images: string[] = [];
  for (const line of instructions(content)) {
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from?.[1]) {
      if (!stages.has(from[1].toLowerCase())) images.push(from[1]);
      if (from[2]) stages.add(from[2].toLowerCase());
      continue;
    }
    if (!/^(?:COPY|ADD)\s/i.test(line)) continue;
    for (const match of line.matchAll(/--from=(\S+)/gi)) {
      const source = match[1];
      if (source && !stages.has(source.toLowerCase()) && !/^\d+$/.test(source)) images.push(source);
    }
  }
  return images;
}

/** The `image` of every service in the Compose files that exist. */
function composeImages(): string[] {
  const images: string[] = [];
  for (const file of COMPOSE_FILES) {
    if (!existsSync(path.join(root as string, file))) continue;
    const document: unknown = parse(read(file), { merge: true });
    const services =
      (document as { services?: Record<string, { image?: unknown } | null> } | null)?.services ??
      {};
    for (const service of Object.values(services)) {
      if (service?.image === undefined) continue;
      images.push(
        typeof service.image === 'string' ? service.image : JSON.stringify(service.image),
      );
    }
  }
  return images;
}

describe('toolchain pins', () => {
  it.each(DOCKERFILES)('%s installs pnpm only from a tarball with the pinned sha512', (file) => {
    const { version, sha512 } = pinnedPnpm();
    const verified = `RUN npm pack pnpm@${version} --pack-destination /tmp && echo "${sha512}  /tmp/pnpm-${version}.tgz" | sha512sum -c - && npm install -g /tmp/pnpm-${version}.tgz && rm /tmp/pnpm-${version}.tgz`;
    const installers = instructions(read(file)).filter(
      (line) => /^(?:RUN|ADD|COPY)\s/i.test(line) && PNPM_SOURCE.test(line),
    );
    expect(installers).toEqual([verified]);
  });

  it('keeps the build stage identical across the three images', () => {
    const stage = (file: string) => {
      const content = read(file);
      return {
        directives: parserDirectives(content),
        instructions: instructions(content).filter((line) => !/^(?:EXPOSE|CMD)\s/i.test(line)),
      };
    };
    const [first, ...rest] = DOCKERFILES.map(stage);
    expect(first?.instructions).toContain('RUN pnpm install --frozen-lockfile');
    for (const other of rest) expect(other).toEqual(first);
  });

  it('pins every base image and every Compose image by tag and digest', () => {
    const references = [
      ...DOCKERFILES.flatMap((file) => dockerfileImages(read(file))),
      ...composeImages(),
    ];
    expect(references.length).toBeGreaterThanOrEqual(6);
    for (const reference of references) expect(reference).toMatch(DIGEST_PINNED);
  });

  it('declares no install hook in any workspace project', () => {
    const manifests = [
      'package.json',
      ...['apps', 'packages'].flatMap((dir) =>
        readdirSync(path.join(root, dir), { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() && existsSync(path.join(root, dir, entry.name, 'package.json')),
          )
          .map((entry) => `${dir}/${entry.name}/package.json`),
      ),
    ];
    expect(manifests.length).toBeGreaterThanOrEqual(6);
    for (const manifest of manifests) {
      const { scripts = {} } = JSON.parse(read(manifest)) as { scripts?: Record<string, string> };
      expect(
        INSTALL_HOOKS.filter((hook) => hook in scripts),
        manifest,
      ).toEqual([]);
    }
    for (const hooks of ['.pnpmfile.cjs', '.pnpmfile.mjs']) {
      expect(existsSync(path.join(root, hooks)), hooks).toBe(false);
    }
  });
});
