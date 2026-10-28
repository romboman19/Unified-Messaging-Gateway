import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The release version, read from the monorepo's root package.json — the one
 * place a release bumps. `npm_package_version` is only set under `npm run`,
 * and the container starts the API with plain `node`.
 */
function readVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string; workspaces?: unknown };
      if (pkg.workspaces && pkg.version) return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

export const APP_VERSION = readVersion();
