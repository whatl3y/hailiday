import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SourceKind } from '@holiday/core';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger/index.js';
import type { AssetPermission } from '../policy/index.js';
import { isHeldKey } from './keys.js';

export type BucketKind = 'private' | 'public';

/** Maximum lifetime of a presigned GET (15 minutes). */
export const MAX_SIGNED_GET_SECONDS = 900;
/** Maximum lifetime of a presigned upload policy (5 minutes). */
export const MAX_UPLOAD_POLICY_SECONDS = 300;

export const PRIVATE_CACHE_CONTROL = 'private, no-store';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/**
 * Share cards, shared copies and example pairs: browsers revalidate after 5 minutes while the CDN
 * keeps them for an hour, so a revoked share stops serving from browser caches quickly and the CDN
 * entry is purged on revocation.
 */
export const CARD_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600';

/** One bucket lifecycle expiration rule, by key prefix or by object tag. */
export interface LifecycleRule {
  id: string;
  prefix?: string;
  tag?: { key: string; value: string };
  expirationDays: number;
}

/** The outcome of applying lifecycle rules; some local S3 emulators do not implement them. */
export interface LifecycleResult {
  applied: boolean;
  reason: string | null;
}

/**
 * Invalidates CDN paths of public objects. `none` (local development and tests: no CDN in front
 * of the public bucket) records the keys it was asked to purge instead.
 */
export interface CdnPurger {
  readonly kind: 'none' | 'cloudfront';
  purge(keys: readonly string[]): Promise<void>;
}

/** The local purger: no CDN exists, so a purge is recorded (most recent 1,000 keys) and logged. */
export function createLocalCdnPurger(logger?: Logger): CdnPurger & { readonly purged: string[] } {
  const purged: string[] = [];
  return {
    kind: 'none',
    purged,
    async purge(keys) {
      purged.push(...keys);
      if (purged.length > 1000) purged.splice(0, purged.length - 1000);
      logger?.debug({ count: keys.length }, 'cdn purge recorded (no cdn configured)');
    },
  };
}

/** What produced the bytes being written; the storage client enforces the Street View rule. */
export interface WriteProvenance {
  /** Source kind the bytes derive from, or `system` for content and generated art. */
  sourceKind: SourceKind | 'system';
  /** The evaluated permission of the source; required when `sourceKind` is `street_view`. */
  permission?: AssetPermission | null;
  /**
   * True for a decorated derivative (accepted output, download, share copy) governed by the
   * derivative permission; false (default) for source pixels and anything cut from them
   * (originals, working images, masks, crops, thumbnails).
   */
  derivative?: boolean;
}

/** Raised when a write of Street View pixels is not covered by an evaluated permission. */
export class StorageWriteRefusedError extends Error {
  readonly key: string;
  constructor(key: string, reason: string) {
    super(`Storage write refused for ${key}: ${reason}`);
    this.name = 'StorageWriteRefusedError';
    this.key = key;
  }
}

export interface PutObjectInput {
  bucket: BucketKind;
  key: string;
  body: Uint8Array | string;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  provenance: WriteProvenance;
}

export interface HeadResult {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
  metadata: Record<string, string>;
}

export interface GetResult extends HeadResult {
  body: Buffer;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
  maxBytes: number;
}

export interface Storage {
  readonly buckets: Readonly<Record<BucketKind, string>>;
  /** Server-side client (`S3_ENDPOINT`). */
  readonly client: S3Client;
  put(input: PutObjectInput): Promise<{ etag: string | null }>;
  get(bucket: BucketKind, key: string): Promise<GetResult | null>;
  head(bucket: BucketKind, key: string): Promise<HeadResult | null>;
  copy(input: {
    from: { bucket: BucketKind; key: string };
    to: { bucket: BucketKind; key: string };
    cacheControl?: string;
    contentType?: string;
    provenance: WriteProvenance;
  }): Promise<void>;
  delete(bucket: BucketKind, key: string): Promise<void>;
  /** Deletes every object under a prefix (never under `held/`); returns the count deleted. */
  deletePrefix(bucket: BucketKind, prefix: string): Promise<number>;
  list(bucket: BucketKind, prefix: string, limit?: number): Promise<string[]>;
  /** Presigned GET for the browser, signed for `S3_PUBLIC_ENDPOINT`, at most 15 minutes. */
  presignGet(
    bucket: BucketKind,
    key: string,
    options?: { expiresInSeconds?: number; cacheControl?: string; contentDisposition?: string },
  ): Promise<string>;
  /**
   * Presigned POST into one exact key with a content-length range and an exact Content-Type
   * condition, at most 5 minutes.
   */
  presignUpload(input: {
    key: string;
    contentType: string;
    maxBytes?: number;
    minBytes?: number;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload>;
  /** Unsigned URL of a public object (hero, example, shared copy, share card). */
  publicUrl(key: string): string;
  bucketExists(bucket: string): Promise<boolean>;
  ensureBucket(bucket: string): Promise<boolean>;
  putBucketCors(bucket: string, origins: readonly string[]): Promise<void>;
  putPublicReadPolicy(bucket: string): Promise<void>;
  /**
   * Replaces a bucket's lifecycle configuration with expiration rules (each also aborts incomplete
   * multipart uploads after one day). An endpoint that does not implement lifecycle configuration
   * returns `applied: false` instead of failing.
   */
  putLifecycleRules(bucket: string, rules: readonly LifecycleRule[]): Promise<LifecycleResult>;
  /** The bucket's lifecycle rules, or null when none exist or the endpoint does not support them. */
  getLifecycleRules(bucket: string): Promise<LifecycleRule[] | null>;
  /** Invalidates the CDN paths of public objects after they were deleted or replaced. */
  purgePublic(keys: readonly string[]): Promise<void>;
  /** The CDN purger in use (`none` records purges for tests and local development). */
  readonly cdn: CdnPurger;
  destroy(): void;
}

export interface CreateStorageOptions {
  /** Override bucket names (tests use `test-` prefixed buckets). */
  buckets?: Partial<Record<BucketKind, string>>;
  logger?: Logger;
  /** CDN invalidation for public objects; defaults to the local recording purger. */
  cdn?: CdnPurger;
}

const LIFECYCLE_UNSUPPORTED = new Set([
  'NotImplemented',
  'NotImplementedError',
  'MethodNotAllowed',
  'NoSuchLifecycleConfiguration',
]);

function lifecycleUnsupported(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const named = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = named.name ?? named.Code ?? '';
  if (LIFECYCLE_UNSUPPORTED.has(name)) return name;
  const status = named.$metadata?.httpStatusCode;
  if (status === 501 || status === 405) return `http_${status}`;
  return null;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    named.name === 'NotFound' ||
    named.name === 'NoSuchKey' ||
    named.name === 'NoSuchBucket' ||
    named.$metadata?.httpStatusCode === 404
  );
}

function assertWriteAllowed(key: string, provenance: WriteProvenance): Record<string, string> {
  if (provenance.sourceKind !== 'street_view') {
    return { 'source-kind': provenance.sourceKind };
  }
  const permission = provenance.permission;
  if (!permission) {
    throw new StorageWriteRefusedError(key, 'street_view write without an evaluated permission');
  }
  if (provenance.derivative) {
    if (!permission.edit) {
      throw new StorageWriteRefusedError(key, 'street_view derivative without edit permission');
    }
  } else if (!permission.store) {
    throw new StorageWriteRefusedError(key, 'street_view pixels without store permission');
  }
  return {
    'source-kind': 'street_view',
    'evidence-id': permission.evidenceId.slice(0, 200),
    derivative: provenance.derivative ? 'true' : 'false',
  };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const withBytes = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withBytes.transformToByteArray === 'function') {
    return Buffer.from(await withBytes.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function s3Client(config: AppConfig, endpoint: string): S3Client {
  return new S3Client({
    region: config.storage.region,
    endpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Creates the storage client: the only writer of object storage. */
export function createStorage(config: AppConfig, options: CreateStorageOptions = {}): Storage {
  const client = s3Client(config, config.storage.endpoint);
  const publicClient =
    config.storage.publicEndpoint === config.storage.endpoint
      ? client
      : s3Client(config, config.storage.publicEndpoint);
  const buckets: Record<BucketKind, string> = {
    private: options.buckets?.private ?? config.storage.privateBucket,
    public: options.buckets?.public ?? config.storage.publicBucket,
  };
  const publicBase =
    options.buckets?.public && options.buckets.public !== config.storage.publicBucket
      ? `${config.storage.publicEndpoint}/${options.buckets.public}`
      : config.storage.publicAssetBaseUrl;
  const cdn = options.cdn ?? createLocalCdnPurger(options.logger);

  const head = async (bucket: BucketKind, key: string): Promise<HeadResult | null> => {
    try {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: buckets[bucket], Key: key }),
      );
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
        lastModified: result.LastModified ?? null,
        metadata: result.Metadata ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const list = async (bucket: BucketKind, prefix: string, limit = 1000): Promise<string[]> => {
    const found: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: buckets[bucket],
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: Math.min(1000, limit - found.length),
        }),
      );
      for (const object of page.Contents ?? []) if (object.Key) found.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && found.length < limit);
    return found;
  };

  const storage: Storage = {
    buckets,
    client,

    async put(input) {
      const provenanceMetadata = assertWriteAllowed(input.key, input.provenance);
      const result = await client.send(
        new PutObjectCommand({
          Bucket: buckets[input.bucket],
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          CacheControl:
            input.cacheControl ?? (input.bucket === 'private' ? PRIVATE_CACHE_CONTROL : undefined),
          ContentDisposition: input.contentDisposition,
          Metadata: { ...(input.metadata ?? {}), ...provenanceMetadata },
        }),
      );
      return { etag: result.ETag ?? null };
    },

    async get(bucket, key) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: buckets[bucket], Key: key }),
        );
        return {
          body: await streamToBuffer(result.Body),
          contentLength: result.ContentLength ?? 0,
          contentType: result.ContentType ?? null,
          etag: result.ETag ?? null,
          lastModified: result.LastModified ?? null,
          metadata: result.Metadata ?? {},
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    head,

    async copy(input) {
      const source = await head(input.from.bucket, input.from.key);
      const provenanceMetadata = assertWriteAllowed(input.to.key, input.provenance);
      await client.send(
        new CopyObjectCommand({
          Bucket: buckets[input.to.bucket],
          Key: input.to.key,
          CopySource: encodeURI(`${buckets[input.from.bucket]}/${input.from.key}`),
          MetadataDirective: 'REPLACE',
          ContentType: input.contentType ?? source?.contentType ?? 'application/octet-stream',
          CacheControl:
            input.cacheControl ??
            (input.to.bucket === 'private' ? PRIVATE_CACHE_CONTROL : undefined),
          Metadata: { ...(source?.metadata ?? {}), ...provenanceMetadata },
        }),
      );
    },

    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: buckets[bucket], Key: key }));
    },

    async deletePrefix(bucket, prefix) {
      if (!prefix || prefix === '/') throw new RangeError('Refusing to delete an empty prefix');
      if (isHeldKey(prefix)) throw new RangeError('Objects under held/ are never bulk-deleted');
      let deleted = 0;
      for (;;) {
        const batch = (await list(bucket, prefix, 1000)).filter((key) => !isHeldKey(key));
        if (batch.length === 0) break;
        await client.send(
          new DeleteObjectsCommand({
            Bucket: buckets[bucket],
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += batch.length;
        if (batch.length < 1000) break;
      }
      return deleted;
    },

    list,

    async presignGet(bucket, key, presignOptions = {}) {
      const expiresIn = Math.min(
        presignOptions.expiresInSeconds ?? config.storage.signedUrlTtlSeconds,
        MAX_SIGNED_GET_SECONDS,
      );
      return getSignedUrl(
        publicClient,
        new GetObjectCommand({
          Bucket: buckets[bucket],
          Key: key,
          ResponseCacheControl:
            presignOptions.cacheControl ??
            (bucket === 'private' ? PRIVATE_CACHE_CONTROL : undefined),
          ResponseContentDisposition: presignOptions.contentDisposition,
        }),
        { expiresIn },
      );
    },

    async presignUpload(input) {
      const maxBytes = input.maxBytes ?? config.storage.uploadMaxBytes;
      const minBytes = input.minBytes ?? 1;
      const expires = Math.min(
        input.expiresInSeconds ?? config.storage.uploadPolicyTtlSeconds,
        MAX_UPLOAD_POLICY_SECONDS,
      );
      const post = await createPresignedPost(publicClient, {
        Bucket: buckets.private,
        Key: input.key,
        Conditions: [
          ['content-length-range', minBytes, maxBytes],
          ['eq', '$Content-Type', input.contentType],
        ],
        Fields: { 'Content-Type': input.contentType },
        Expires: expires,
      });
      return {
        url: post.url,
        fields: post.fields,
        expiresAt: new Date(Date.now() + expires * 1000),
        maxBytes,
      };
    },

    publicUrl(key) {
      return `${publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
    },

    async bucketExists(bucket) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },

    async ensureBucket(bucket) {
      if (await storage.bucketExists(bucket)) return false;
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
        return false;
      }
      options.logger?.info({ bucket }, 'bucket created');
      return true;
    },

    async putBucketCors(bucket, origins) {
      await client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [...origins],
                AllowedMethods: ['GET', 'POST', 'PUT', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );
    },

    async putPublicReadPolicy(bucket) {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'PublicRead',
                Effect: 'Allow',
                Principal: { AWS: ['*'] },
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${bucket}/*`],
              },
            ],
          }),
        }),
      );
    },

    async putLifecycleRules(bucket, rules) {
      try {
        await client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: {
              Rules: rules.map((rule) => ({
                ID: rule.id,
                Status: 'Enabled',
                Filter: rule.tag
                  ? { Tag: { Key: rule.tag.key, Value: rule.tag.value } }
                  : { Prefix: rule.prefix ?? '' },
                Expiration: { Days: rule.expirationDays },
                ...(rule.tag ? {} : { AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
              })),
            },
          }),
        );
        return { applied: true, reason: null };
      } catch (error) {
        const reason = lifecycleUnsupported(error);
        if (!reason) throw error;
        options.logger?.warn({ bucket, reason }, 'bucket lifecycle rules not supported');
        return { applied: false, reason };
      }
    },

    async getLifecycleRules(bucket) {
      try {
        const result = await client.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
        );
        return (result.Rules ?? []).map((rule) => {
          const tag = rule.Filter?.Tag;
          return {
            id: rule.ID ?? '',
            ...(tag?.Key
              ? { tag: { key: tag.Key, value: tag.Value ?? '' } }
              : { prefix: rule.Filter?.Prefix ?? rule.Prefix ?? '' }),
            expirationDays: rule.Expiration?.Days ?? 0,
          };
        });
      } catch (error) {
        if (lifecycleUnsupported(error) || isNotFound(error)) return null;
        throw error;
      }
    },

    async purgePublic(keys) {
      if (keys.length === 0) return;
      await cdn.purge(keys);
    },

    cdn,

    destroy() {
      client.destroy();
      if (publicClient !== client) publicClient.destroy();
    },
  };
  return storage;
}
