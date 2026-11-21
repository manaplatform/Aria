const fs = require('node:fs');
const path = require('node:path');
const desktop = path.resolve(__dirname, '..');
const root = path.resolve(desktop, '../..');

function notice(directory) {
  const manifest = path.join(directory, 'package.json');
  if (!fs.existsSync(manifest)) return;
  const { name, version, license } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!name || !version || name.startsWith('@aria/')) return;
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (file) =>
        file.isFile() &&
        (/^(licen[cs]e|copying|notice)([._-]|$)/i.test(file.name) ||
          (name === 'cookie-signature' && /^readme\.md$/i.test(file.name))),
    )
    .filter((file) => fs.statSync(path.join(directory, file.name)).size <= 2_000_000)
    .map((file) => ({
      name: file.name,
      text: fs.readFileSync(path.join(directory, file.name), 'utf8'),
    }));
  if (!files.length && name === '@ai-sdk/provider-utils' && version === '5.0.79') {
    const name = 'ai-sdk-provider-utils-5.0.79.txt';
    const text = fs.readFileSync(path.join(root, 'third-party/licenses', name), 'utf8');
    files.push({ name, text });
  }
  const known =
    !license &&
    ['busboy', 'streamsearch'].includes(name) &&
    files.some(({ text }) => text.includes('Permission is hereby granted, free of charge'));
  return { name, version, license: license || (known ? 'MIT' : null), files };
}

function rendererNotices(chunks) {
  const packages = new Map();
  for (const chunk of Object.values(chunks)) {
    if (chunk.type !== 'chunk') continue;
    for (const id of Object.keys(chunk.modules)) {
      const file = id.replace(/^\0/, '').split('?')[0];
      if (!path.isAbsolute(file) || !file.replaceAll('\\', '/').includes('/node_modules/'))
        continue;
      let directory = path.dirname(file);
      while (
        path.dirname(directory) !== directory &&
        !fs.existsSync(path.join(directory, 'package.json'))
      )
        directory = path.dirname(directory);
      const result = notice(directory);
      if (result) packages.set(`${result.name}@${result.version}`, result);
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function packageEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const entry = path.join(directory, name);
    if (!fs.statSync(entry).isDirectory()) return [];
    return name.startsWith('@')
      ? fs.readdirSync(entry).map((pkg) => path.join(entry, pkg))
      : [entry];
  });
}

function check(release) {
  const dist = path.join(desktop, 'dist');
  const staged = path.join(desktop, 'dist-electron/api/node_modules/.pnpm');
  const renderer = JSON.parse(fs.readFileSync(path.join(dist, 'renderer-licenses.json'), 'utf8'));
  const api = fs
    .readdirSync(staged)
    .filter((name) => name !== 'node_modules')
    .flatMap((name) => packageEntries(path.join(staged, name, 'node_modules')))
    .map(notice)
    .filter(Boolean);
  const main = ['zod', 'ws', 'ipaddr.js', 'yaml', 'yauzl']
    .map((name) =>
      notice(
        fs.realpathSync(
          path.join(
            name === 'ipaddr.js' ? path.join(root, 'packages/shared') : desktop,
            'node_modules',
            name,
          ),
        ),
      ),
    )
    .filter(Boolean);
  const yauzl = fs.realpathSync(path.join(desktop, 'node_modules', 'yauzl'));
  for (const name of Object.keys(
    JSON.parse(fs.readFileSync(path.join(yauzl, 'package.json'), 'utf8')).dependencies ?? {},
  )) {
    const dependency = require.resolve(`${name}/package.json`, { paths: [yauzl] });
    const entry = notice(path.dirname(dependency));
    if (entry) main.push(entry);
  }
  const packages = [
    ...new Map(
      [...api, ...main, ...renderer].map((entry) => [`${entry.name}@${entry.version}`, entry]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  if (!api.length || !renderer.length || !main.length)
    throw new Error('Incomplete production dependency inventory.');

  const destination = path.join(dist, 'third-party');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(
    path.join(root, 'THIRD_PARTY_NOTICES.md'),
    path.join(destination, 'THIRD_PARTY_NOTICES.md'),
  );
  fs.writeFileSync(
    path.join(destination, 'packages.txt'),
    packages
      .map(({ name, version, license, files }) =>
        [
          `${name}@${version} — ${license || 'No SPDX metadata'}`,
          ...files.map((file) => `\n${file.name}\n${file.text}`),
        ].join('\n'),
      )
      .join('\n\n'),
  );
  const electronPackage = require.resolve('electron/package.json');
  const runtimeDirectory =
    process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(path.dirname(electronPackage), 'dist');
  const runtimeVersion = fs
    .readFileSync(path.join(runtimeDirectory, 'version'), 'utf8')
    .trim()
    .replace(/^v/, '');
  const expectedVersion = JSON.parse(fs.readFileSync(electronPackage, 'utf8')).version;
  if (release && runtimeVersion !== expectedVersion)
    throw new Error('Install the pinned Electron runtime for a release audit.');
  for (const name of ['LICENSE', 'LICENSES.chromium.html'])
    fs.copyFileSync(
      path.join(runtimeDirectory, name),
      path.join(destination, name === 'LICENSE' ? 'LICENSE.electron' : name),
    );
  const firstParty = [
    'package.json',
    'apps/desktop/package.json',
    'apps/api/package.json',
    'packages/shared/package.json',
  ];
  const hasLicense = fs.existsSync(path.join(root, 'LICENSE'));
  if (release || hasLicense) {
    const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    const body = (text) =>
      text
        .slice(text.indexOf('Permission is hereby granted, free of charge'))
        .replace(/\s+/g, ' ')
        .trim();
    const upstreamExample = fs.readFileSync(path.join(runtimeDirectory, 'LICENSE'), 'utf8');
    if (
      !license.startsWith('MIT License') ||
      !/^Copyright \(c\) 2026 .+/m.test(license) ||
      body(license) !== body(upstreamExample)
    )
      throw new Error('The first-party MIT notice is missing its verified 2026 holder.');
    for (const file of firstParty) {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (metadata.license !== 'MIT' || metadata.private !== true)
        throw new Error(`Review MIT and privacy metadata in ${file}.`);
    }
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    if (!readme.includes('](LICENSE)')) throw new Error('README must link to the MIT license.');
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
  }
  const review = packages.filter(
    ({ license, files }) =>
      !license || !files.length || /CC-|MPL|(?:A?GPL|LGPL)|SEE LICENSE/i.test(license),
  );
  for (const { name, version, license, files } of review)
    console.log(
      `Review: ${name}@${version} ${license || 'unknown'}${files.length ? '' : ' (no top-level notice file)'}`,
    );
  console.log(
    `Collected notices for ${packages.length} resolved packages and Electron ${runtimeVersion}.`,
  );
}

module.exports = { rendererNotices };
if (require.main === module) check(process.argv.includes('--release'));
