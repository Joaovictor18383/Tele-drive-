import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname, relative, basename, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Execute o empacotamento em Windows x64.');
}
const root = resolve(import.meta.dirname, '..');
const release = join(root, 'release');
await mkdir(release, { recursive: true });
const work = await mkdtemp(join(release, '.build-'));
const stage = join(work, 'runtime');
const bundle = join(work, 'runtime.zip');
const system = process.env.WINDIR || 'C:\\Windows';
const framework = join(system, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = join(framework, 'csc.exe');
const output = join(release, 'CloudVault.exe');
const sdkVersion = '1.0.4370.26';
const sdkChecksum = '1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4';

async function prepareWebView() {
  const cache = join(root, '.cloudvault-dev', 'webview2-' + sdkVersion + '.nupkg');
  let archive = await readFile(cache).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const verified = bytes => createHash('sha256').update(bytes).digest('hex') === sdkChecksum;
  if (!archive || !verified(archive)) {
    const url = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + sdkVersion + '/microsoft.web.webview2.' + sdkVersion + '.nupkg';
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('Não foi possível baixar o WebView2 SDK do NuGet.');
    archive = Buffer.from(await response.arrayBuffer());
    if (!verified(archive)) throw new Error('A soma de verificação do WebView2 SDK não corresponde à versão fixada.');
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, archive);
  }
  const sdk = join(work, 'webview-sdk');
  const desktop = join(stage, 'webview');
  await Promise.all([mkdir(sdk, { recursive: true }), mkdir(desktop, { recursive: true })]);
  const core = join(sdk, 'Microsoft.Web.WebView2.Core.dll');
  const forms = join(sdk, 'Microsoft.Web.WebView2.WinForms.dll');
  const files = new Map([
    ['lib/net462/Microsoft.Web.WebView2.Core.dll', core],
    ['lib/net462/Microsoft.Web.WebView2.WinForms.dll', forms],
    ['runtimes/win-x64/native/WebView2Loader.dll', join(desktop, 'WebView2Loader.dll')],
    ['LICENSE.txt', join(desktop, 'LICENSE.txt')]
  ]);
  const zip = new ZipReader(new Uint8ArrayReader(archive));
  try {
    const entries = await zip.getEntries();
    for (const [name, target] of files) {
      const entry = entries.find(file => file.filename === name);
      if (!entry || entry.directory) throw new Error('Arquivo ausente no WebView2 SDK: ' + name);
      await writeFile(target, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally { await zip.close(); }
  return { core, forms };
}

try {
  await mkdir(join(stage, 'dist'), { recursive: true });
  const webView = await prepareWebView();
  await cp(process.execPath, join(stage, 'node.exe'));
  await cp(join(root, 'dist', 'web'), join(stage, 'dist', 'web'), { recursive: true });
  await build({
    absWorkingDir: root, entryPoints: ['windows/backend.ts'], bundle: true, format: 'esm',
    platform: 'node', target: 'node22', packages: 'external', outfile: join(stage, 'backend.mjs')
  });

  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages;
  const chosen = new Set();
  async function include(name, importer, optional = false) {
    let parent = importer;
    let candidate;
    while (true) {
      const path = (parent ? parent + '/' : '') + 'node_modules/' + name;
      if (lock[path]) { candidate = path; break; }
      if (!parent) break;
      const next = dirname(parent);
      parent = next === '.' ? '' : next;
    }
    if (!candidate) {
      if (optional) return;
      throw new Error('Dependência ausente no lockfile: ' + name);
    }
    if (chosen.has(candidate)) return;
    const from = join(root, candidate);
    const info = await stat(from).catch(error => {
      if (optional && error.code === 'ENOENT') return;
      throw error;
    });
    if (!info?.isDirectory()) return;
    chosen.add(candidate);
    await cp(from, join(stage, candidate), {
      recursive: true, filter: entry => entry === from || !relative(from, entry).split(sep).includes('node_modules')
    });
    const meta = lock[candidate];
    for (const dep of Object.keys(meta.dependencies || {})) await include(dep, candidate);
    for (const dep of Object.keys(meta.optionalDependencies || {})) await include(dep, candidate, true);
    for (const dep of Object.keys(meta.peerDependencies || {})) {
      await include(dep, candidate, !!meta.peerDependenciesMeta?.[dep]?.optional);
    }
  }
  for (const name of ['@fastify/cookie', '@fastify/helmet', '@fastify/rate-limit', '@fastify/static', 'fastify', 'telegram', 'zod', 'qrcode', 'jose', 'big-integer']) {
    await include(name, '');
  }

  execFileSync(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:CV_PACK_STAGE, $env:CV_PACK_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $false)"
  ], { env: { ...process.env, CV_PACK_STAGE: stage, CV_PACK_ZIP: bundle }, stdio: 'inherit' });

  const png = await readFile(join(root, 'public', 'icon-192.png'));
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory[6] = 192;
  directory[7] = 192;
  directory.writeUInt16LE(1, 10);
  directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(png.length, 14);
  directory.writeUInt32LE(directory.length, 18);
  const icon = join(work, 'CloudVault.ico');
  await writeFile(icon, Buffer.concat([directory, png]));

  const capsule = createHash('sha256').update(await readFile(bundle)).digest('hex').slice(0, 12);
  const version = join(work, 'PackageId.cs');
  await writeFile(version, 'internal static class PackageId { public const string Value = "' + capsule + '"; }\n');
  const result = join(work, basename(output));
  execFileSync(compiler, [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/out:' + result,
    '/win32icon:' + icon, '/resource:' + bundle + ',CloudVault.Runtime.zip',
    '/resource:' + webView.core + ',CloudVault.WebView.Core',
    '/resource:' + webView.forms + ',CloudVault.WebView.WinForms',
    '/reference:' + webView.core, '/reference:' + webView.forms,
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    join(root, 'windows', 'Launcher.cs'), join(root, 'windows', 'DesktopWindow.cs'), version
  ], { stdio: 'inherit' });

  const testDir = join(work, 'selftest');
  await mkdir(testDir);
  execFileSync(result, ['--self-test', testDir], { timeout: 90_000, stdio: 'inherit' });
  console.log((await readFile(join(testDir, 'resultado.txt'), 'utf8')).trim());
  await rename(result, output);
  console.log(output + ' (' + ((await stat(output)).size / 1024 ** 2).toFixed(1) + ' MiB)');
} catch (error) {
  const report = await readFile(join(work, 'selftest', 'resultado.txt'), 'utf8').catch(() => '');
  if (report) console.error(report);
  throw error;
} finally {
  if (dirname(work) === release && basename(work).startsWith('.build-')) await rm(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
