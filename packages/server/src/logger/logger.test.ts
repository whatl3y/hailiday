import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, isSensitiveKey, scrubLogObject } from './index.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, destination };
}

describe('logger redaction', () => {
  const syntheticAddress = '742 Evergreen Terrace, Springfield, IL 62704';
  const syntheticKey = 'AIzaSyFAKE-test-key-1234567890';

  it('never writes a synthetic address or provider key', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: 'info', destination, secrets: [syntheticKey] });
    logger.info(
      {
        address: syntheticAddress,
        nested: { formattedAddress: syntheticAddress, deeper: [{ query: '742 Everg' }] },
        email: 'person@example.com',
        req: { headers: { cookie: 'hs=abc', authorization: 'Bearer abc' } },
        signed: 'https://s3.example/k?X-Amz-Signature=abcdef&X-Amz-Credential=x',
        renderJobId: '0197c1d2-0000-7000-8000-000000000000',
      },
      `calling provider with ${syntheticKey}`,
    );
    logger.error({ err: new Error(`bad key ${syntheticKey}`) }, 'provider failed');
    const output = lines.join('');
    expect(output).not.toContain(syntheticAddress);
    expect(output).not.toContain('742 Everg');
    expect(output).not.toContain(syntheticKey);
    expect(output).not.toContain('person@example.com');
    expect(output).not.toContain('hs=abc');
    expect(output).not.toContain('X-Amz-Signature');
    expect(output).toContain('0197c1d2-0000-7000-8000-000000000000');
    expect(output).toContain(REDACTED);
  });

  it('classifies keys by name', () => {
    expect(isSensitiveKey('displayAddress')).toBe(true);
    expect(isSensitiveKey('email_normalized')).toBe(true);
    expect(isSensitiveKey('tokenHash')).toBe(true);
    expect(isSensitiveKey('displayAddressBasis')).toBe(false);
    expect(isSensitiveKey('promptVersion')).toBe(false);
    expect(isSensitiveKey('state')).toBe(false);
    expect(scrubLogObject({ list: [{ address: 'x' }] })).toEqual({ list: [{ address: REDACTED }] });
  });
});
