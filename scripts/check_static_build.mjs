// Static checks run without a server. Add --serve for a real HTTP refresh check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const serve = args.includes('--serve');
const baseIndex = args.indexOf('--base');
const base = baseIndex < 0 ? process.env.VITE_BASE_PATH || '/LogisticsCase1/' : args[baseIndex + 1];
const dist = join(root, 'frontend/dist');
assert(base && base.startsWith('/') && base.endsWith('/') && !base.includes('..'), 'Use a slash-delimited Vite base');

async function files(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fileForUrl(url) {
  const pathname = decodeURIComponent(new URL(url, 'https://example.test').pathname);
  assert(pathname.startsWith(base), `Resource does not use Vite base ${base}: ${url}`);
  const target = resolve(dist, pathname.slice(base.length));
  assert(target === dist || target.startsWith(dist + sep), 'Resource escapes the build directory');
  return target;
}

async function main() {
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  const resources = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]).filter(url => !/^(https?:|data:|#)/.test(url));
  assert(resources.length > 0, 'Production HTML has no built resources');
  for (const url of resources) await access(fileForUrl(url));

  const fixtures = join(root, 'contracts/fixtures');
  const geography = join(root, 'contracts/geography');
  const canonical = (await files(fixtures)).filter(path => /\.(json|geojson)$/.test(path)).map(path => [path, join(dist, 'demo', relative(fixtures, path))]);
  for (const name of await readdir(geography)) {
    if (name.endsWith('.geojson') || name === 'manifest.json') canonical.push([join(geography, name), join(dist, 'geography', name)]);
  }
  for (const [source, target] of canonical) assert.equal(hash(await readFile(target)), hash(await readFile(source)), `Build data differs: ${relative(root, target)}`);
  const metadata = JSON.parse(await readFile(join(dist, 'demo/forecast/metadata.json'), 'utf8'));
  const descriptor = JSON.parse(await readFile(join(dist, 'demo/forecast/geography.json'), 'utf8'));
  assert.deepEqual(descriptor, metadata.geography, 'Static geography and metadata differ');
  for (const layer of descriptor.layers ?? []) await access(fileForUrl(base + layer.asset_path));
  assert(!(await readdir(join(dist, 'geography'))).includes('source'), 'Acquisition snapshots must not ship to the browser');
  console.log(`Static build paths and ${canonical.length} canonical data copies pass (${base}).`);
  if (!serve) return;

  const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/geo+json' };
  const server = createServer(async (request, response) => {
    try {
      let target = fileForUrl(request.url);
      if ((await stat(target)).isDirectory()) target = join(target, 'index.html');
      const information = await stat(target);
      response.writeHead(200, { 'Content-Type': contentType[extname(target)] || 'application/octet-stream', 'Content-Length': information.size });
      response.end(request.method === 'HEAD' ? undefined : await readFile(target));
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const suffix of ['', 'index.html', '?year=2029&metric=population&scenario=baseline&feature=district-sovetsky', '?year=2027#main-content']) {
      const response = await fetch(origin + base + suffix);
      assert.equal(response.status, 200, `Page refresh failed: ${suffix}`);
      assert((await response.text()).includes('id="root"'), 'Page refresh did not return the actual application');
    }
    for (const url of resources) assert.equal((await fetch(origin + url, { method: 'HEAD' })).status, 200, `Built asset failed: ${url}`);
    for (const layer of descriptor.layers ?? []) assert.equal((await fetch(origin + base + layer.asset_path, { method: 'HEAD' })).status, 200, `Geography asset failed: ${layer.id}`);
    assert.equal((await fetch(origin + base + 'not-a-client-route')).status, 404, 'Do not mask missing resources with an SPA fallback');
    console.log('HTTP page refresh (root, index, query/hash) and built assets pass without fallback routing.');
  } finally { await new Promise(resolveClose => server.close(resolveClose)); }
}

main().catch(error => { console.error(`Static build check failed: ${error.message}`); process.exitCode = 1; });
