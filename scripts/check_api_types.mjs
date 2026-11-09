// Check generation without modifying the checked-in TypeScript artifact.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'logistics-api-types-'));
try {
  const generated = join(temporary, 'api.generated.ts');
  execFileSync(process.execPath, [join(root, 'frontend/node_modules/openapi-typescript/bin/cli.js'), join(root, 'contracts/openapi.json'), '-o', generated], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (await readFile(generated, 'utf8') !== await readFile(join(root, 'contracts/api.generated.ts'), 'utf8')) {
    throw new Error('Stale API TypeScript. Run python scripts/export_contract.py and pnpm types:generate, then commit all generated contracts.');
  }
  console.log('Generated API TypeScript matches FastAPI OpenAPI.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
