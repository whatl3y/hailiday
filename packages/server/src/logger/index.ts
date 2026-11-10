import { pino } from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export const REDACTED = '[REDACTED]';

/**
 * Field names whose values never reach a log line, at any depth. Matching is case-insensitive
 * on the normalized key (underscores and dashes removed).
 */
const SENSITIVE_KEY_PATTERN =
  /(address|formattedaddress|email|query|cookie|authorization|token|secret|password|apikey|signature|signedurl|downloadurl|beforeurl|afterurl|displayurl|presign|credential|sessionid|manualentry|prompt|^url$|^href$|^lat$|^lng$|latitude|longitude|targetlat|targetlng)/;

/** Fields whose name ends with one of these are kept even if they match above. */
const SAFE_KEY_SUFFIXES = [
  'basis',
  'storedat',
  'verifiedat',
  'kind',
  'count',
  'class',
  'mode',
  'version',
  'provider',
];

/** Values that look like signed URLs are scrubbed whatever their key. */
const SIGNED_URL_PATTERN =
  /(X-Amz-Signature|X-Amz-Credential|[?&]signature=|[?&]sig=|[?&]key=AIza)/i;

const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Returns a copy of a log object with sensitive fields and signed URLs replaced. */
export function scrubLogObject(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return SIGNED_URL_PATTERN.test(value) ? REDACTED : value;
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => scrubLogObject(item, depth + 1));
  if (value instanceof Error) {
    const copy: Record<string, unknown> = {
      type: value.name,
      message: scrubLogObject(value.message, depth + 1),
      stack: value.stack,
    };
    for (const [key, inner] of Object.entries(value)) {
      copy[key] = isSensitiveKey(key) ? REDACTED : scrubLogObject(inner, depth + 1);
    }
    return copy;
  }
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (isSensitiveKey(key) && inner !== null && inner !== undefined) {
      result[key] = REDACTED;
    } else {
      result[key] = scrubLogObject(inner, depth + 1);
    }
  }
  return result;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CreateLoggerOptions {
  level?: LoggerOptions['level'];
  name?: string;
  /** Secret values (provider keys, passwords) scrubbed from every serialized line. */
  secrets?: readonly string[];
  /** Output stream; defaults to stdout. */
  destination?: DestinationStream;
  base?: Record<string, unknown>;
}

/** Paths redacted by pino's fast path before the generic scrubber runs. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-turnstile-token"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
];

/**
 * Creates the pino logger used by every process. Sensitive keys (addresses, emails, queries,
 * tokens, cookies, authorization, signed URLs, coordinates, prompts) are replaced at any depth,
 * and configured secret values are scrubbed from the final line, including message text.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const secrets = [...new Set(options.secrets ?? [])].filter((secret) => secret.length >= 6);
  const secretPattern =
    secrets.length > 0 ? new RegExp(secrets.map(escapeForRegExp).join('|'), 'g') : null;

  const loggerOptions: LoggerOptions = {
    level: options.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => scrubLogObject(object) as Record<string, unknown>,
    },
    hooks: {
      streamWrite: (line) => {
        let output = line;
        if (secretPattern) output = output.replace(secretPattern, REDACTED);
        return output;
      },
    },
  };
  if (options.name) loggerOptions.name = options.name;
  if (options.base) loggerOptions.base = options.base;
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}

/** A logger that discards everything (tests and scripts that need a placeholder). */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
