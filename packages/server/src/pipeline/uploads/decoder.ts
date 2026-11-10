import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A decline decided by the decoder (uploads spec, server-side validation). */
export interface DecodeDecline {
  code: 'UPLOAD_UNSUPPORTED_FORMAT' | 'UPLOAD_TOO_LARGE' | 'VALIDATION_FAILED';
  reason: 'unsupported_format' | 'animated' | 'too_many_pixels' | 'image_too_small' | 'unreadable';
}

export type DecodeResult =
  | {
      ok: true;
      bytes: Buffer;
      width: number;
      height: number;
      originalWidth: number;
      originalHeight: number;
      orientation: number;
      hasAlpha: boolean;
      space: string | null;
      hasIcc: boolean;
    }
  | { ok: false; decline: DecodeDecline };

/** The decode exceeded its wall-clock limit or the child crashed: an infrastructure failure. */
export class DecodeInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeInfrastructureError';
  }
}

export interface DecodeLimits {
  maxPixels: number;
  minShortEdge: number;
  maxLongEdge: number;
  quality: number;
  timeoutMs: number;
  /** Heap limit of the child in megabytes. */
  memoryMb: number;
}

export const DEFAULT_DECODE_LIMITS: DecodeLimits = {
  maxPixels: 50_000_000,
  minShortEdge: 640,
  maxLongEdge: 2048,
  quality: 90,
  timeoutMs: 20_000,
  memoryMb: 1024,
};

/** The child script: the build output's `.js`, or the `.ts` source under tests. */
function childScript(): string {
  const js = fileURLToPath(new URL('./decoder-child.js', import.meta.url));
  if (existsSync(js)) return js;
  return fileURLToPath(new URL('./decoder-child.ts', import.meta.url));
}

/**
 * Decodes and normalizes untrusted bytes in a short-lived child process with a minimal
 * environment (no credentials), a heap limit and a wall-clock limit. The parent only receives
 * normalized JPEG bytes or a decline; a crash or timeout fails one job, never the worker.
 */
export function decodeInChild(
  bytes: Uint8Array,
  sniffed: 'jpeg' | 'png' | 'webp',
  limits: Partial<DecodeLimits> = {},
): Promise<DecodeResult> {
  const resolved = { ...DEFAULT_DECODE_LIMITS, ...limits };
  return new Promise((resolve, reject) => {
    const child = fork(childScript(), [], {
      env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
      execArgv: [`--max-old-space-size=${resolved.memoryMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new DecodeInfrastructureError('decode exceeded its time limit')));
    }, resolved.timeoutMs);
    child.on('message', (message: unknown) => {
      const response = message as DecodeResult;
      finish(() =>
        resolve(response.ok ? { ...response, bytes: Buffer.from(response.bytes) } : response),
      );
    });
    child.on('error', (error) =>
      finish(() => reject(new DecodeInfrastructureError(error.message))),
    );
    child.on('exit', (code, signal) => {
      finish(() =>
        reject(
          new DecodeInfrastructureError(
            `decoder exited before replying (code ${code ?? 'null'}, signal ${signal ?? 'none'})${
              stderr ? `: ${stderr.slice(0, 300)}` : ''
            }`,
          ),
        ),
      );
    });
    child.send({
      bytes,
      sniffed,
      maxPixels: resolved.maxPixels,
      minShortEdge: resolved.minShortEdge,
      maxLongEdge: resolved.maxLongEdge,
      quality: resolved.quality,
    });
  });
}
