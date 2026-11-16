import { prepareTestDatabase } from '@hailiday/server/db';
import { emptyTestBucketsAfterRun } from '@hailiday/server/storage';
import { TEST_BUCKETS } from './buckets.js';

/**
 * Vitest global setup: recreate and migrate the integration-test database once per run. The
 * teardown it returns empties the buckets the suites wrote to.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await prepareTestDatabase({ fresh: true });
  return () => emptyTestBucketsAfterRun(Object.values(TEST_BUCKETS));
}
