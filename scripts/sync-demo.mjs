// The backend and demo browser consume the same canonical fixtures.
import { cp, mkdir, readdir, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const geographyDirectory = new URL('../contracts/geography/', import.meta.url);
const ready = await Promise.all(['roads.geojson', 'buildings.geojson'].map(name => access(new URL(name, geographyDirectory)).then(() => true, () => false)));
if (ready.includes(false)) {
  const generated = spawnSync('python3', [fileURLToPath(new URL('./import_geography.py', import.meta.url))], { stdio: 'inherit' });
  if (generated.status !== 0) throw new Error('Geography preparation failed. Install Python 3.11+ and run python3 scripts/import_geography.py.');
}
const source = new URL('../contracts/fixtures/', import.meta.url);
const destination = new URL('../frontend/public/demo/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
const geographySource = new URL('../contracts/geography/', import.meta.url);
const geographyTarget = new URL('../frontend/public/geography/', import.meta.url);
await rm(geographyTarget, { recursive: true, force: true });
await mkdir(geographyTarget, { recursive: true });
for (const name of await readdir(geographySource)) {
  // Acquisition snapshots and import scripts remain in the repository, not in
  // the browser's distribution. Only declared ready-to-render assets ship.
  if (name.endsWith('.geojson') || name === 'manifest.json') await cp(new URL(name, geographySource), new URL(name, geographyTarget));
}
console.log('Forecast fixtures and real geography copied.');
