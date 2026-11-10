import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger/index.js';
import {
  MAX_PROVIDER_MESSAGE_LENGTH,
  anthropicErrorDiagnostics,
  googleErrorDiagnostics,
  logProviderFailure,
  openAiErrorDiagnostics,
  redactProviderText,
} from './diagnostics.js';

const bytes = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

describe('redactProviderText', () => {
  it('removes configured secrets and anything key-like', () => {
    const text = redactProviderText(
      'Incorrect API key provided: sk-proj-****wxyz. Key AIzaSyA1234567890abcdefghij is invalid; ' +
        'Authorization: Bearer abc.def.ghi; url https://x.example/a?key=secret-value&size=1; ' +
        'token 0123456789abcdef0123456789abcdef01 and the literal my-configured-secret.',
      ['my-configured-secret'],
    );
    for (const leaked of [
      'sk-proj',
      'wxyz',
      'AIzaSy',
      'abc.def.ghi',
      'secret-value',
      '0123456789abcdef0123456789abcdef01',
      'my-configured-secret',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('Incorrect API key provided');
    expect(text).toContain('size=1');
  });

  it('collapses whitespace and truncates long messages', () => {
    expect(redactProviderText('  a \n\t b  ')).toBe('a b');
    const long = redactProviderText('word '.repeat(400));
    expect(long.length).toBe(MAX_PROVIDER_MESSAGE_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('vendor error bodies', () => {
  it('reads OpenAI code, type, parameter and message', () => {
    expect(
      openAiErrorDiagnostics(
        bytes({
          error: {
            message: "Invalid value for 'input_fidelity': not supported for this model.",
            type: 'invalid_request_error',
            param: 'input_fidelity',
            code: 'invalid_input_fidelity_model',
          },
        }),
      ),
    ).toEqual({
      code: 'invalid_input_fidelity_model',
      message: "Invalid value for 'input_fidelity': not supported for this model.",
      param: 'input_fidelity',
      type: 'invalid_request_error',
    });
    expect(openAiErrorDiagnostics(bytes({ error: { type: 'server_error' } }))).toEqual({
      code: 'server_error',
      type: 'server_error',
    });
  });

  it('keeps a redacted excerpt of a non-JSON body', () => {
    const diagnostics = openAiErrorDiagnostics(
      bytes('<html><body><h1>502 Bad Gateway</h1> key=AIzaSyA1234567890abcdefghij</body></html>'),
    );
    expect(diagnostics.message).toContain('502 Bad Gateway');
    expect(diagnostics.message).not.toContain('AIzaSy');
    expect(diagnostics.code).toBeUndefined();
  });

  it('reads Google status, message and the offending field', () => {
    expect(
      googleErrorDiagnostics(
        bytes({
          error: {
            code: 400,
            message: 'Thinking level LOW is not supported for this model.',
            status: 'INVALID_ARGUMENT',
          },
        }),
      ),
    ).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'Thinking level LOW is not supported for this model.',
      param: 'generationConfig.thinkingConfig.thinkingLevel',
    });
    expect(
      googleErrorDiagnostics(
        bytes({
          error: {
            code: 400,
            message: 'Invalid value at field.',
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: [{ field: 'generation_config.image_config.image_size' }],
              },
            ],
          },
        }),
      ).param,
    ).toBe('generation_config.image_config.image_size');
    expect(
      googleErrorDiagnostics(
        bytes({
          error: {
            code: 400,
            message:
              'Invalid JSON payload received. Unknown name "thinkingBudget" at \'generation_config\': Cannot find field.',
            status: 'INVALID_ARGUMENT',
          },
        }),
      ).param,
    ).toBe('thinkingBudget');
    expect(
      googleErrorDiagnostics(
        bytes({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' }),
      ),
    ).toEqual({ code: 'REQUEST_DENIED', message: 'The provided API key is invalid.' });
  });

  it('reads an Anthropic SDK error without its headers', () => {
    const error = Object.assign(new Error('400 {"type":"error"}'), {
      status: 400,
      headers: { 'x-api-key': 'sk-ant-should-never-appear-123456' },
      error: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens: must be at most 64000' },
      },
    });
    const diagnostics = anthropicErrorDiagnostics(error, ['sk-ant-should-never-appear-123456']);
    expect(diagnostics).toEqual({
      code: 'invalid_request_error',
      message: 'max_tokens: must be at most 64000',
    });
    expect(JSON.stringify(diagnostics)).not.toContain('sk-ant');
  });
});

describe('logProviderFailure', () => {
  it('logs the diagnostics at warn level', () => {
    const warn = vi.fn();
    logProviderFailure(
      { warn } as unknown as Logger,
      { provider: 'openai', operation: 'image_edit', httpStatus: 400, kind: 'invalid_request' },
      { code: 'invalid_mask_image_format', message: 'Invalid mask.', param: 'mask' },
    );
    expect(warn).toHaveBeenCalledWith(
      {
        provider: 'openai',
        operation: 'image_edit',
        httpStatus: 400,
        failureKind: 'invalid_request',
        providerCode: 'invalid_mask_image_format',
        providerMessage: 'Invalid mask.',
        providerParam: 'mask',
      },
      'provider call failed',
    );
    expect(() =>
      logProviderFailure(undefined, { provider: 'x', operation: 'y' }, {}),
    ).not.toThrow();
  });
});
