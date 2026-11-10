import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { buildErrorBody } from '@holiday/core';
import { AppError, isAppError, toAppError, validationFailed } from '@holiday/server/errors';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { App } from './types.js';
import { isApiPath, pathOnly } from './types.js';

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  keyword?: string;
}

/** Converts a Fastify schema validation error into `VALIDATION_FAILED` with field paths. */
function fromValidation(error: FastifyError): AppError<'VALIDATION_FAILED'> {
  const context = (error as { validationContext?: string }).validationContext ?? 'body';
  const issues = (error.validation ?? []) as ValidationIssue[];
  const fields = issues.slice(0, 20).map((issue) => {
    const path = (issue.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
    return {
      path: path ? `${context}.${path}` : context,
      reason: (issue.message ?? issue.keyword ?? 'invalid').slice(0, 200),
    };
  });
  return validationFailed({ fields });
}

/**
 * Maps any thrown value to an `AppError` when it has a client meaning: our own `AppError`s, schema
 * validation failures and Fastify's 4xx errors (malformed JSON, body too large, unsupported media
 * type, not found). Anything else is an internal failure (null).
 */
export function classifyError(error: unknown): AppError | null {
  if (isAppError(error)) return error;
  const converted = toAppError(error);
  if (converted) return converted;
  const fastifyError = error as FastifyError;
  if (hasZodFastifySchemaValidationErrors(error) || Array.isArray(fastifyError?.validation)) {
    return fromValidation(fastifyError);
  }
  const status = typeof fastifyError?.statusCode === 'number' ? fastifyError.statusCode : 0;
  if (status === 404) return new AppError('NOT_FOUND', {});
  if (status >= 400 && status < 500) {
    return validationFailed({
      fields: [{ path: 'request', reason: (fastifyError.code ?? 'invalid_request').toLowerCase() }],
    });
  }
  return null;
}

/** Sends an `AppError` as the core error envelope with its status and headers. */
export function sendAppError(request: FastifyRequest, reply: FastifyReply, error: AppError) {
  return reply
    .code(error.httpStatus)
    .headers(error.responseHeaders())
    .type('application/json; charset=utf-8')
    .send(error.toBody(request.id));
}

/**
 * The error handler: `AppError` becomes `{ error: { code, message, requestId, retryable, details } }`
 * with the status from the core error table and `Retry-After`/`RateLimit` headers; unexpected
 * failures become a generic 500 envelope that never carries vendor errors or stack traces.
 */
export function registerErrorHandling(
  app: App,
  options: {
    /** Renders the 404 document for a page route (GET outside the JSON APIs). */
    onPageNotFound?: (request: FastifyRequest, reply: FastifyReply) => unknown;
  } = {},
): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = classifyError(error);
    if (appError) {
      request.log.info(
        { code: appError.code, status: appError.httpStatus, path: pathOnly(request.url) },
        'request refused',
      );
      return sendAppError(request, reply, appError);
    }
    request.log.error({ err: error, path: pathOnly(request.url) }, 'request failed');
    return reply
      .code(500)
      .type('application/json; charset=utf-8')
      .send(
        buildErrorBody('PROVIDER_UNAVAILABLE', {
          requestId: request.id,
          details: { provider: null },
          message: 'Internal error.',
        }),
      );
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || isApiPath(request.url)) {
      return sendAppError(request, reply, new AppError('NOT_FOUND', {}));
    }
    if (options.onPageNotFound) return options.onPageNotFound(request, reply);
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  });
}
