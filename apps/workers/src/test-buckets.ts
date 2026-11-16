import { TEST_BUCKET_SUFFIX } from '@hailiday/server/storage';

/** The buckets the worker's integration tests write to, as the configuration overrides that select them. */
export const TEST_BUCKETS = {
  S3_PRIVATE_BUCKET: `test-workers-private${TEST_BUCKET_SUFFIX}`,
  S3_PUBLIC_BUCKET: `test-workers-public${TEST_BUCKET_SUFFIX}`,
} as const;
