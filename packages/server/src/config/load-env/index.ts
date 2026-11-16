/**
 * Preload for host development (`node --import @hailiday/server/config/load-env`): loads the
 * repository's root `.env` into `process.env` before the app reads its configuration. Variables set
 * in the shell win, except provider keys, which come only from the file, and the refused vendor
 * redirect variables, which are removed wherever they come from.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceEnvFile } from '../dotenv.js';

const result = loadWorkspaceEnvFile(process.env, path.dirname(fileURLToPath(import.meta.url)));
if (result.dropped.length > 0) {
  process.stderr.write(
    `Ignoring ${result.dropped.join(', ')} from the shell: provider keys are read only from .env\n`,
  );
}
if (result.refused.length > 0) {
  process.stderr.write(
    `Ignoring ${result.refused.join(', ')}: provider requests always go to the vendor's own host\n`,
  );
}
