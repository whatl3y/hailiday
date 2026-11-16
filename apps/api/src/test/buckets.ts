import { TEST_BUCKET_SUFFIX } from '@hailiday/server/storage';

/** The buckets the API's integration tests write to, as the configuration overrides that select them. */
export const TEST_BUCKETS = {
  S3_PRIVATE_BUCKET: `test-api-private${TEST_BUCKET_SUFFIX}`,
  S3_PUBLIC_BUCKET: `test-api-public${TEST_BUCKET_SUFFIX}`,
} as const;
