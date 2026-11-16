import {
  DeleteMeResponseSchema,
  EmptyObjectSchema,
  MagicLinkRequestSchema,
  VerifyMagicLinkRequestSchema,
  VerifyMagicLinkResponseSchema,
  maskEmail,
  normalizeEmail,
  type AuthTokenPurpose,
  type UserRole,
} from '@hailiday/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MINUTE_MS, addMs } from '@hailiday/server/clock';
import {
  isUniqueViolation,
  toJson,
  type AnonymousSession,
  type DbOrTx,
  type Tx,
  type User,
} from '@hailiday/server/db';
import { validationFailed } from '@hailiday/server/errors';
import { newId, randomToken, sha256Hex } from '@hailiday/server/ids';
import { charge } from '@hailiday/server/ledger';
import {
  RETENTION,
  TOMBSTONE_RETENTION_MS,
  deleteProject,
  mirrorTombstones,
  setDeletionRequestStatus,
} from '@hailiday/server/pipeline';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { enforceEndpointLimit } from '../auth/limits.js';
import {
  USER_SESSION_IDLE_MS,
  attachSessionToOwner,
  clearSessionCookie,
  createAnonymousSession,
  csrfTokenFor,
  ipHashOf,
  isOperatorEmail,
  requireSession,
  requireUser,
  resetAuth,
  setSessionCookie,
  type AuthState,
} from '../auth/session.js';
import { emitEvent, writeAudit } from '../domain/events.js';

export { isOperatorEmail };

/** App routes a magic link may return to (relative paths only). */
const RETURN_TO_PATTERN =
  /^\/(?:$|p\/[0-9a-f-]{36}$|places$|account$|upload$|dont-decorate-my-home$)/;
const PROJECT_RETURN_TO = /^\/p\/([0-9a-f-]{36})$/;

/** Rows re-owned when an anonymous session signs in. */
const CLAIMED_TABLES = [
  'properties',
  'projects',
  'sourceAssets',
  'renderJobs',
  'renderAssets',
  'usageLedger',
  'shareGrants',
  'feedback',
  'allowanceResidue',
] as const;

/**
 * Creates a single-use auth token and emails its link; only the token's hash is stored. `db` puts
 * the token row and the ledger line in the caller's transaction.
 */
export async function sendAuthLink(
  deps: ApiDeps,
  request: FastifyRequest,
  input: {
    email: string;
    purpose: AuthTokenPurpose;
    sessionId: string;
    ownerId: string;
    returnTo: string | null;
    db?: DbOrTx;
  },
): Promise<void> {
  const now = deps.clock.now();
  const token = randomToken(32);
  const db = input.db ?? deps.db;
  await db
    .insertInto('authTokens')
    .values({
      id: newId(),
      tokenHash: sha256Hex(token),
      emailNormalized: normalizeEmail(input.email),
      purpose: input.purpose,
      requestedFromSessionId: input.sessionId,
      returnTo: input.returnTo,
      expiresAt: addMs(now, deps.config.auth.magicLinkTtlMinutes * MINUTE_MS),
      ipHash: ipHashOf(deps, request),
    })
    .execute();
  const link = `${deps.config.publicBaseUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  const minutes = deps.config.auth.magicLinkTtlMinutes;
  const reauth = input.purpose === 'operator_reauth';
  await deps.email.send({
    to: input.email,
    subject: reauth ? 'Confirm it is you' : 'Your Hailiday sign-in link',
    text: reauth
      ? `Use this link within ${minutes} minutes to confirm an operations change:\n\n${link}\n`
      : `Here is your link to sign in to Hailiday and save your places. It works for ${minutes} minutes and can be used once.\n\n${link}\n\nIf you didn't ask for it, you can ignore this email.`,
    tag: input.purpose,
  });
  await charge(
    db,
    {
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      isFixture: deps.email.kind === 'fixture',
    },
    { provider: deps.email.kind, sku: 'email', stage: input.purpose },
    deps.clock,
  );
}

/** Moves every owner-scoped row of an anonymous owner to the signed-in owner. */
async function claimOwnerRows(trx: Tx, from: string, to: string): Promise<number> {
  const projects = await trx
    .selectFrom('projects')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('ownerId', '=', from)
    .where('deletedAt', 'is', null)
    .executeTakeFirstOrThrow();
  for (const table of CLAIMED_TABLES) {
    await trx
      .updateTable(table)
      .set({ ownerId: to } as never)
      .where('ownerId' as never, '=', from as never)
      .execute();
  }
  return Number(projects.count);
}

async function findOrCreateUser(deps: ApiDeps, trx: Tx, email: string, now: Date) {
  const normalized = normalizeEmail(email);
  const existing = await trx
    .selectFrom('users')
    .selectAll()
    .where('emailNormalized', '=', normalized)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  const operator = isOperatorEmail(deps, normalized);
  if (existing) {
    // The stored operator role follows the allowlist at every sign-in: granted when listed,
    // removed when not.
    const roles: UserRole[] = operator
      ? existing.roles.includes('operator')
        ? existing.roles
        : [...existing.roles, 'operator']
      : existing.roles.filter((role) => role !== 'operator');
    const user = await trx
      .updateTable('users')
      .set({
        lastLoginAt: now,
        emailVerifiedAt: existing.emailVerifiedAt ?? now,
        roles,
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { user, created: false };
  }
  const ownerId = newId();
  await trx.insertInto('owners').values({ id: ownerId, kind: 'user' }).execute();
  const user = await trx
    .insertInto('users')
    .values({
      id: newId(),
      ownerId,
      emailNormalized: normalized,
      emailVerifiedAt: now,
      roles: operator ? ['user', 'operator'] : ['user'],
      lastLoginAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { user, created: true };
}

type VerifyOutcome =
  | { confirmationRequired: true; emailHint: string }
  | {
      confirmationRequired: false;
      user: User;
      claimedProjects: number;
      returnTo: string | null;
      created: boolean;
      /** The verifying session after sign-in (null for an operator re-authentication). */
      session: AnonymousSession | null;
    };

/**
 * A project return path is kept only when the signed-in owner can open that project; any other
 * project path becomes `/places`, so a link requested elsewhere never lands on a missing page.
 */
async function ownReturnTo(
  trx: Tx,
  returnTo: string | null,
  ownerId: string,
): Promise<string | null> {
  const projectId = returnTo ? PROJECT_RETURN_TO.exec(returnTo)?.[1] : undefined;
  if (!projectId) return returnTo;
  const project = await trx
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .where('ownerId', '=', ownerId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return project ? returnTo : '/places';
}

/**
 * Magic-link verification. Only the verifying session is ever signed in, and only its own
 * anonymous rows are claimed. A link opened in the session that asked for it signs in at once. A
 * link opened anywhere else first answers `confirmationRequired` and changes nothing (the token
 * stays unused); the repeat call with `confirm` signs in the verifying session. The session that
 * asked for the link keeps its rows and stays signed out: whoever typed the email proved nothing
 * about the account, so nothing of theirs is moved into it.
 *
 * Signing in is one transaction: the token is consumed, the user (and owner) created when new,
 * the verifying session repointed to the user's owner with a new session token, its previous
 * anonymous owner's rows re-owned and saved, and `session.claim` audited for that owner.
 */
async function verifyToken(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthState,
  token: string,
  confirm: boolean,
): Promise<VerifyOutcome> {
  const now = deps.clock.now();
  const row = await deps.db
    .selectFrom('authTokens')
    .selectAll()
    .where('tokenHash', '=', sha256Hex(token))
    .executeTakeFirst();
  if (!row) throw validationFailed({ reason: 'unknown' });
  if (row.consumedAt) throw validationFailed({ reason: 'consumed' });
  if (row.expiresAt.getTime() <= now.getTime()) throw validationFailed({ reason: 'expired' });

  if (row.purpose === 'operator_reauth') {
    if (!auth.user || auth.user.emailNormalized !== row.emailNormalized) {
      throw validationFailed({ reason: 'unknown' });
    }
    const consumed = await deps.db
      .updateTable('authTokens')
      .set({ consumedAt: now, requestedFromSessionId: auth.session.id, ipHash: null })
      .where('id', '=', row.id)
      .where('consumedAt', 'is', null)
      .executeTakeFirst();
    if (Number(consumed.numUpdatedRows ?? 0) === 0) throw validationFailed({ reason: 'consumed' });
    return {
      confirmationRequired: false,
      user: auth.user,
      claimedProjects: 0,
      returnTo: row.returnTo,
      created: false,
      session: null,
    };
  }

  const sameSession = row.requestedFromSessionId === auth.session.id;
  if (!sameSession && !confirm) {
    return { confirmationRequired: true, emailHint: maskEmail(row.emailNormalized) };
  }

  const signIn = () =>
    deps.db.transaction().execute(async (trx) => {
      const consumed = await trx
        .updateTable('authTokens')
        .set({ consumedAt: now, ipHash: null })
        .where('id', '=', row.id)
        .where('consumedAt', 'is', null)
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows ?? 0) === 0)
        throw validationFailed({ reason: 'consumed' });
      const { user, created } = await findOrCreateUser(deps, trx, row.emailNormalized, now);
      let claimed = 0;
      const from = auth.ownerId;
      const previous =
        from === user.ownerId
          ? undefined
          : await trx.selectFrom('owners').select('kind').where('id', '=', from).executeTakeFirst();
      if (previous?.kind === 'anonymous') {
        claimed += await claimOwnerRows(trx, from, user.ownerId);
        await writeAudit(trx, {
          actorUserId: user.id,
          actorKind: 'user',
          action: 'session.claim',
          targetKind: 'owner',
          targetId: user.ownerId,
          before: { ownerId: from },
          after: { ownerId: user.ownerId },
          requestId: request.id,
          ipHash: ipHashOf(deps, request),
        });
      }
      await trx
        .updateTable('projects')
        .set({
          savedAt: now,
          lastActivityAt: now,
          expiresAt: addMs(now, RETENTION.savedInactivityMs),
        })
        .where('ownerId', '=', user.ownerId)
        .where('savedAt', 'is', null)
        .where('deletedAt', 'is', null)
        .execute();
      const attached = await attachSessionToOwner(deps, auth.session.id, user.ownerId, trx);
      return {
        confirmationRequired: false as const,
        user,
        claimedProjects: claimed,
        returnTo: await ownReturnTo(trx, row.returnTo, user.ownerId),
        created,
        session: attached.session,
        token: attached.token,
      };
    });
  // Two first sign-ins for the same email can race to create the account; the loser retries
  // once and finds the account the winner created.
  let result: Awaited<ReturnType<typeof signIn>>;
  try {
    result = await signIn();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    result = await signIn();
  }
  setSessionCookie(deps, reply, result.token, USER_SESSION_IDLE_MS);
  resetAuth(request);
  if (result.claimedProjects > 0 || result.created) {
    await emitEvent(deps, deps.db, {
      name: 'project_saved',
      ownerId: result.user.ownerId,
      properties: { newAccount: result.created },
    });
  }
  return result;
}

function userDto(user: User) {
  return { id: user.id, email: user.emailNormalized, roles: user.roles };
}

/**
 * The one confirmation email account deletion sends, before the address is removed. A delivery
 * failure is logged and never blocks the deletion.
 */
async function sendDeletionConfirmation(
  deps: ApiDeps,
  request: FastifyRequest,
  email: string,
): Promise<void> {
  try {
    await deps.email.send({
      to: email,
      subject: 'Your Hailiday account is being deleted',
      text:
        'We received your request to delete your Hailiday account. Your account, your saved places, ' +
        'their photos and decorated images, and your share links are being deleted now; nothing ' +
        'else is needed from you.\n\nThis is the last email we will send to this address, which ' +
        'is removed from Hailiday with your account.',
      tag: 'account_deleted',
    });
  } catch (error) {
    request.log.warn({ err: error }, 'account deletion confirmation email failed');
  }
}

/** Magic-link sign-in, logout and account deletion. */
export function registerAuthRoutes(app: App, deps: ApiDeps): void {
  app.post(
    '/v1/auth/magic-link',
    { schema: { body: MagicLinkRequestSchema, response: { 202: EmptyObjectSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const email = normalizeEmail(request.body.email);
      enforceEndpointLimit(deps, request, reply, 'magic_link', { auth, email });
      const returnTo =
        request.body.returnTo && RETURN_TO_PATTERN.test(request.body.returnTo)
          ? request.body.returnTo
          : null;
      await sendAuthLink(deps, request, {
        email,
        purpose: 'magic_link',
        sessionId: auth.session.id,
        ownerId: auth.ownerId,
        returnTo,
      });
      reply.code(202);
      return {};
    },
  );

  app.post(
    '/v1/auth/verify',
    {
      schema: {
        body: VerifyMagicLinkRequestSchema,
        response: { 200: VerifyMagicLinkResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      enforceEndpointLimit(deps, request, reply, 'auth_verify', { auth });
      const result = await verifyToken(
        deps,
        request,
        reply,
        auth,
        request.body.token,
        request.body.confirm === true,
      );
      if (result.confirmationRequired) {
        return { confirmationRequired: true as const, emailHint: result.emailHint };
      }
      reply.header('X-CSRF-Token', csrfTokenFor(deps, result.session ?? auth.session));
      return {
        user: userDto(result.user),
        claimedProjects: result.claimedProjects,
        returnTo: result.returnTo,
      };
    },
  );

  app.post(
    '/v1/auth/logout',
    { schema: { body: EmptyObjectSchema.optional() } },
    async (request, reply) => {
      const auth = await requireUser(deps, request, reply);
      const now = deps.clock.now();
      await deps.db
        .updateTable('anonymousSessions')
        .set({ expiresAt: now })
        .where('id', '=', auth.session.id)
        .execute();
      resetAuth(request);
      // The replacement session is a fresh anonymous owner with a fresh allowance, so it carries
      // no bot-check verification: its first paid action runs the challenge again.
      await createAnonymousSession(deps, request, reply, {
        timezone: auth.session.timezone,
        turnstileVerifiedAt: null,
      });
      return reply.code(204).send();
    },
  );

  app.delete(
    '/v1/me',
    { schema: { response: { 202: DeleteMeResponseSchema } } },
    async (request, reply) => {
      const auth = await requireUser(deps, request, reply);
      const now = deps.clock.now();
      const projects = await deps.db
        .selectFrom('projects')
        .selectAll()
        .where('ownerId', '=', auth.ownerId)
        .where('deletedAt', 'is', null)
        .execute();
      const variants = await deps.db
        .selectFrom('renderAssets')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('ownerId', '=', auth.ownerId)
        .where('deletedAt', 'is', null)
        .executeTakeFirstOrThrow();
      const requestId = newId();
      await sendDeletionConfirmation(deps, request, auth.user.emailNormalized);
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('deletionRequests')
          .values({
            id: requestId,
            ownerId: auth.ownerId,
            scope: 'account',
            targetId: auth.ownerId,
            requestedBy: 'user',
            accessRevokedAt: now,
            status: 'in_progress',
          })
          .execute();
        await trx
          .updateTable('anonymousSessions')
          .set({ expiresAt: now })
          .where('ownerId', '=', auth.ownerId)
          .execute();
        // Every sign-in and re-authentication token ever issued for the address goes with it.
        await trx
          .deleteFrom('authTokens')
          .where('emailNormalized', '=', auth.user.emailNormalized)
          .execute();
        await trx
          .updateTable('users')
          .set({ deletedAt: now, emailNormalized: `deleted:${auth.user.id}` })
          .where('id', '=', auth.user.id)
          .execute();
        await trx
          .updateTable('owners')
          .set({ deletedAt: now })
          .where('id', '=', auth.ownerId)
          .execute();
        await trx
          .updateTable('shareGrants')
          .set({ revokedAt: now })
          .where('ownerId', '=', auth.ownerId)
          .where('revokedAt', 'is', null)
          .execute();
        await trx
          .insertInto('tombstones')
          .values({
            id: newId(),
            kind: 'owner',
            hashSha256: sha256Hex(auth.ownerId),
            deletionRequestId: requestId,
            deletedAt: now,
            retainUntil: addMs(now, TOMBSTONE_RETENTION_MS),
          })
          .onConflict((oc) => oc.columns(['kind', 'hashSha256']).doNothing())
          .execute();
      });
      clearSessionCookie(deps, reply);
      resetAuth(request);
      // The owner tombstone leaves the database at once, as each project's tombstones do; a
      // storage failure here leaves it to the retention sweep's mirror run.
      try {
        await mirrorTombstones(deps.pipeline, { deletionRequestId: requestId });
      } catch (error) {
        request.log.warn({ err: error }, 'owner tombstone mirror failed during account deletion');
      }

      let failed = false;
      let held = false;
      let projectsDeleted = 0;
      let objectsDeleted = 0;
      for (const project of projects) {
        try {
          const outcome = await deleteProject(deps.pipeline, {
            project,
            scope: 'account',
            requestedBy: 'user',
          });
          objectsDeleted += outcome.objectsDeleted;
          if (outcome.status === 'held') held = true;
          else if (outcome.status === 'completed') projectsDeleted += 1;
        } catch (error) {
          failed = true;
          request.log.error({ err: error }, 'project deletion failed during account deletion');
        }
      }
      // A project kept under a preservation hold keeps the account request `held` until the
      // deletion resume settles it; only projects actually deleted count as rows deleted.
      if (failed) {
        await deps.db
          .updateTable('deletionRequests')
          .set({
            status: 'failed',
            receipt: toJson([
              {
                store: 'database',
                objectsDeleted: 0,
                rowsDeleted: projectsDeleted,
                completedAt: null,
                verifiedAt: null,
                error: 'project_deletion_failed',
              },
            ]),
          })
          .where('id', '=', requestId)
          .execute();
      } else {
        await setDeletionRequestStatus(deps.pipeline, requestId, held ? 'held' : 'completed', {
          objectsDeleted,
          rowsDeleted: projectsDeleted,
        });
      }
      await emitEvent(deps, deps.db, {
        name: 'project_deleted',
        ownerId: auth.ownerId,
        properties: { scope: 'account', variantCount: Number(variants.count) },
      });
      reply.code(202);
      return { deletionRequestId: requestId };
    },
  );
}

/**
 * Whether a session re-authenticated within the configured window: an `operator_reauth` token for
 * the signed-in email consumed by this session. Sign-in links never count.
 */
export async function hasFreshReauth(deps: ApiDeps, auth: AuthState): Promise<boolean> {
  if (!auth.user) return false;
  const since = addMs(deps.clock.now(), -deps.config.auth.operatorReauthMinutes * MINUTE_MS);
  const row = await deps.db
    .selectFrom('authTokens')
    .select('id')
    .where('purpose', '=', 'operator_reauth')
    .where('emailNormalized', '=', auth.user.emailNormalized)
    .where('requestedFromSessionId', '=', auth.session.id)
    .where('consumedAt', '>', since)
    .executeTakeFirst();
  return row !== undefined;
}
