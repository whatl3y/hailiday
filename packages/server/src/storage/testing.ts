import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { testConfig, type AppConfig } from '../config/index.js';
import { createStorage } from './client.js';

/** Every bucket an integration test writes to carries this prefix. */
export const TEST_BUCKET_PREFIX = 'test-';

/**
 * The suffix every test bucket name ends with, from `TEST_BUCKET_SUFFIX` (empty when unset). A
 * second checkout of the repository sets it, so its test runs neither share nor empty the first
 * checkout's buckets. Lowercase letters, digits and hyphens only, at most 20 characters.
 */
export function testBucketSuffixFrom(value: string | undefined): string {
  const suffix = value ?? '';
  if (!/^[a-z0-9-]{0,20}$/.test(suffix)) {
    throw new RangeError(
      `TEST_BUCKET_SUFFIX must be lowercase letters, digits or hyphens: ${suffix}`,
    );
  }
  return suffix;
}

export const TEST_BUCKET_SUFFIX = testBucketSuffixFrom(process.env.TEST_BUCKET_SUFFIX);

/** The private and public bucket of one integration suite. */
function testBucketPair(suite: string): { private: string; public: string } {
  return {
    private: `${TEST_BUCKET_PREFIX}${suite}-private${TEST_BUCKET_SUFFIX}`,
    public: `${TEST_BUCKET_PREFIX}${suite}-public${TEST_BUCKET_SUFFIX}`,
  };
}

/** The bucket pairs of the server package's integration suites; each suite writes only to its own. */
export const SERVER_TEST_BUCKETS = {
  pipeline: testBucketPair('pipeline'),
  deletion: testBucketPair('deletion'),
  holds: testBucketPair('holds'),
  revalidation: testBucketPair('revalidation'),
  storage: testBucketPair('hailiday'),
} as const;

/** Whether a bucket name marks a bucket that only integration tests write to. */
export function isTestBucket(name: string): boolean {
  return name.startsWith(TEST_BUCKET_PREFIX) && name.length > TEST_BUCKET_PREFIX.length;
}

/**
 * Deletes every object, held ones included, from the named test buckets and returns how many it
 * removed. Integration tests write uploads, renders and cards into their buckets, and a test run
 * calls this when it ends so they do not pile up in the development storage volume. The buckets
 * themselves stay (the suites create them only when missing), and a bucket that does not exist
 * is skipped. A name without the test prefix is refused before any request is sent, so this can
 * never reach a development or production bucket.
 */
export async function emptyTestBuckets(
  names: readonly string[],
  config: AppConfig = testConfig(),
): Promise<number> {
  for (const name of names) {
    if (!isTestBucket(name)) {
      throw new RangeError(`Refusing to empty a bucket that is not a test bucket: ${name}`);
    }
  }
  const storage = createStorage(config);
  try {
    let deleted = 0;
    for (const name of new Set(names)) {
      if (!(await storage.bucketExists(name))) continue;
      let previousFirst: string | undefined;
      for (;;) {
        const page = await storage.client.send(
          new ListObjectsV2Command({ Bucket: name, MaxKeys: 1000 }),
        );
        const objects = (page.Contents ?? []).flatMap((object) =>
          object.Key ? [{ Key: object.Key }] : [],
        );
        const first = objects[0]?.Key;
        if (first === undefined) break;
        if (first === previousFirst) {
          throw new Error(`Objects in ${name} are still listed after their deletion: ${first}`);
        }
        previousFirst = first;
        const result = await storage.client.send(
          new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects, Quiet: true } }),
        );
        const failed = result.Errors ?? [];
        if (failed.length > 0) {
          const example = failed[0];
          throw new Error(
            `Could not delete ${failed.length} objects from ${name}, for example ${example?.Key ?? '(unnamed)'}: ${example?.Code ?? 'unknown error'}`,
          );
        }
        deleted += objects.length;
      }
    }
    return deleted;
  } finally {
    storage.destroy();
  }
}

/**
 * The teardown of a test run: empties the run's buckets and reports a failure on stderr instead
 * of throwing, so a storage hiccup after the last test never turns a passing run into a failing
 * one.
 */
export async function emptyTestBucketsAfterRun(names: readonly string[]): Promise<void> {
  try {
    await emptyTestBuckets(names);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`The test buckets were not emptied: ${reason}\n`);
  }
}
