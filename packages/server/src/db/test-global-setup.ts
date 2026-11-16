import { SERVER_TEST_BUCKETS, emptyTestBucketsAfterRun } from '../storage/testing.js';
import { prepareTestDatabase } from './testing.js';

/**
 * Vitest global setup: recreate and migrate the integration-test database once per run. The
 * teardown it returns empties the buckets the suites wrote to.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await prepareTestDatabase({ fresh: true });
  return () =>
    emptyTestBucketsAfterRun(
      Object.values(SERVER_TEST_BUCKETS).flatMap((pair) => [pair.private, pair.public]),
    );
}
