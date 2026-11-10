import { prepareTestDatabase } from '@holiday/server/db';

/** Vitest global setup: recreate and migrate the integration-test database once per run. */
export default async function setup(): Promise<void> {
  await prepareTestDatabase({ fresh: true });
}
