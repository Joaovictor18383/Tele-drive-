const packageName = 'io.github.joaovictor18383.cloudvault';
const relation = 'delegate_permission/common.handle_all_urls';

async function fetchFrom(origin, path) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error(`Recurso fora da origem configurada: ${url.href}`);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url.pathname} respondeu HTTP ${response.status}.`);
  return response;
}

async function check(address, certificate) {
  const url = URL.parse(address ?? '');
  if (!url || url.protocol !== 'https:' || url.href !== url.origin + '/') {
    throw new Error('Use: node android/check.mjs https://vault.seudominio.com [CERTIFICADO_SHA256]');
  }
  const { origin } = url;
  if (certificate && !/^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/i.test(certificate)) {
    throw new Error('Informe a impressão digital SHA-256 com 32 pares hexadecimais.');
  }

  const [manifest, health, session] = await Promise.all(
    ['/manifest.webmanifest', '/api/health', '/api/session'].map(async path => (await fetchFrom(origin, path)).json())
  );
  if (health.ok !== true || session.configured !== true) {
    throw new Error('A API deve estar ativa e configurada com as credenciais do Telegram.');
  }
  if (manifest.display !== 'standalone' || new URL(manifest.start_url, origin).origin !== origin) {
    throw new Error('O manifesto precisa definir uma abertura independente na mesma origem.');
  }

  await Promise.all(['192x192', '512x512'].map(async size => {
    const icon = manifest.icons?.find(entry => entry.sizes === size && typeof entry.src === 'string');
    if (!icon) throw new Error(`Ícone ${size} ausente do manifesto.`);
    const response = await fetchFrom(origin, icon.src);
    if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error(`Ícone ${size} inválido.`);
    await response.body?.cancel();
  }));

  if (certificate) {
    const links = await (await fetchFrom(origin, '/.well-known/assetlinks.json')).json();
    const verified = Array.isArray(links) && links.some(link =>
      link.relation?.includes(relation) && link.target?.namespace === 'android_app' &&
      link.target?.package_name === packageName &&
      link.target?.sha256_cert_fingerprints?.some(value => value.toUpperCase() === certificate.toUpperCase())
    );
    if (!verified) throw new Error(`O servidor não associa ${packageName} ao certificado informado.`);
  }

  console.log(certificate ? 'HTTPS, API, PWA e associação do APK verificados.' : 'HTTPS, API e PWA verificados.');
}

try {
  await check(process.argv[2], process.argv[3]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
