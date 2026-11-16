import type { FastifyRequest } from 'fastify';
import { DAY_MS, addMs } from '@hailiday/server/clock';
import { dailySaltedHash } from '@hailiday/server/ids';
import type { ApiDeps } from '../deps.js';

/** The caller's IP address as a hash with a daily rotating salt (never stored raw). */
export function ipHashOf(deps: Pick<ApiDeps, 'config' | 'clock'>, request: FastifyRequest) {
  return dailySaltedHash(deps.config.sessionSecret, `ip:${request.ip}`, deps.clock.now());
}

/**
 * Every salted hash of the caller's IP address that a row from the last 24 hours may carry: the
 * current day's and the previous day's. The rolling 24-hour window never reaches further back
 * than the previous UTC day, so counting both keeps a per-IP count from restarting at 00:00 UTC
 * when the salt rotates.
 */
export function ipHashesInWindowOf(
  deps: Pick<ApiDeps, 'config' | 'clock'>,
  request: FastifyRequest,
): string[] {
  const now = deps.clock.now();
  const value = `ip:${request.ip}`;
  return [
    dailySaltedHash(deps.config.sessionSecret, value, now),
    dailySaltedHash(deps.config.sessionSecret, value, addMs(now, -DAY_MS)),
  ];
}
