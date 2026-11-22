import { readFileSync } from 'node:fs';
import {
  downloadUrl, manifestName, releaseDate, repository, sbomName, signatureName, sumsName,
  windowsCertificateName,
} from './generate-metadata.mjs';

const template = readFileSync(new URL('./release-notes.md', import.meta.url), 'utf8');
const base = `https://github.com/${repository}`;

const headings = {
  breaking: 'Breaking changes',
  feature: 'New features',
  improvement: 'Improvements',
  bug: 'Bug fixes',
  security: 'Security updates',
};

const labelKinds = {
  breaking: ['breaking', 'breaking-change'],
  security: ['security'],
  bug: ['bug', 'bugfix', 'fix'],
  feature: ['feature', 'enhancement-feature'],
  improvement: ['improvement', 'enhancement', 'performance', 'perf', 'dependencies', 'deps'],
};

const conventional = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/i;
const normalizeLabel = (label) => label.toLowerCase().replaceAll(/\s+/g, '-');
const skipNotes = (pull) => pull.labels.some((label) => normalizeLabel(label) === 'skip-release-notes');

function category(title, body, labels = []) {
  const [, type, scope, breaking] = (conventional.exec(title.toLowerCase()) ?? []);
  const names = new Set(labels.map(normalizeLabel));
  const has = (kind) => labelKinds[kind].some((name) => names.has(name));
  if (has('breaking') || breaking || /^BREAKING[ -]CHANGE:\s+\S/m.test(body)) return 'breaking';
  if (has('security') || type === 'security' || (scope === 'security' && type === 'fix')) return 'security';
  if (has('bug') || type === 'fix') return 'bug';
  if (has('feature') || type === 'feat') return 'feature';
  if (has('improvement') || ['refactor', 'perf', 'deps'].includes(type) || ['deps', 'deps-dev'].includes(scope))
    return 'improvement';
  if (/^(fix|repair|correct|prevent)\s/i.test(title)) return 'bug';
  if (/^(add|introduce|enable|implement|support)\s/i.test(title)) return 'feature';
  if (/^(improve|simplify|clarify|refine)\s/i.test(title)) return 'improvement';
}

function plain(value) {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
    .replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    .replace(/[\\`*_[\]{}!@|]/g, '\\$&');
}

function highlights(commits, pulls) {
  const items = new Map(commits.map((item) => [item.sha, item]));
  const covered = new Set();
  const changes = new Map();
  for (const pull of pulls.toSorted((a, b) => a.number - b.number)) {
    const titles = new Map();
    for (const sha of pull.commits) {
      covered.add(sha);
      const item = items.get(sha);
      const kind = category(item.title, item.body);
      if (kind && !titles.has(kind)) titles.set(kind, item.title);
    }
    if (skipNotes(pull)) continue;
    const kind = category(pull.title, pull.body, pull.labels);
    if (kind && (!/^(feat|fix|refactor|chore)\//i.test(pull.title) || !titles.has(kind)))
      titles.set(kind, pull.title);
    for (const [section, title] of titles) add(section, title, `[#${pull.number}](${base}/pull/${pull.number})`);
  }
  for (const item of commits) {
    if (covered.has(item.sha)) continue;
    const kind = category(item.title, item.body);
    if (kind) add(kind, item.title, `[${item.sha.slice(0, 7)}](${base}/commit/${item.sha})`);
  }
  const sections = Object.entries(headings).flatMap(([kind, heading]) =>
    changes.has(kind) ? [`### ${heading}\n\n${changes.get(kind).join('\n')}`] : []);
  return sections.length ? ['## Release highlights', ...sections].join('\n\n') : '';

  function add(kind, title, link) {
    const entries = changes.get(kind) ?? [];
    entries.push(`- ${plain(conventional.exec(title)?.[4] ?? title)} (${link})`);
    changes.set(kind, entries);
  }
}

const platforms = {
  macos: {
    name: 'macOS',
    arches: { arm64: 'Apple Silicon (arm64)', x64: 'Intel (x64)' },
    formats: { dmg: 'Disk image', zip: 'ZIP archive' },
    install: {
      dmg: 'Open the DMG and move Aria to Applications. Quit Aria before replacing an existing copy.',
      zip: 'Extract the ZIP and move Aria to Applications.',
    },
  },
  windows: {
    name: 'Windows',
    arches: { x64: 'x64', arm64: 'ARM64' },
    formats: { exe: 'Installer', 'portable.exe': 'Portable EXE' },
    install: {
      exe: 'Run the installer and follow the prompts.',
      'portable.exe': 'Run the portable EXE directly.',
    },
  },
  linux: {
    name: 'Linux',
    arches: { x64: 'x64', arm64: 'ARM64' },
    formats: { deb: 'DEB', rpm: 'RPM', AppImage: 'AppImage', 'tar.gz': 'TAR.GZ' },
    install: {
      deb: 'Install the DEB on Debian or Ubuntu.',
      rpm: 'Install the RPM on Fedora-compatible distributions.',
      AppImage: 'Make the AppImage executable and open it.',
      'tar.gz': 'Extract the TAR.GZ and run Aria from the extracted directory.',
    },
  },
};

function downloads(assets, link, commit) {
  const sections = [];
  for (const [platform, { name, arches, formats, install }] of Object.entries(platforms)) {
    const packages = assets.filter((asset) => asset.platform === platform);
    if (!packages.length) continue;
    const rows = Object.entries(arches).flatMap(([arch, label]) => {
      const links = packages.filter((asset) => asset.arch === arch)
        .map(({ filename, format }) => link(filename, formats[format]));
      return links.length ? [`- **${label}** · ${links.join(' · ')}`] : [];
    });
    const includedFormats = new Set(packages.map(({ format }) => format));
    const instructions = [...includedFormats].map((format) => install[format]);
    if (platform === 'macos' && includedFormats.has('dmg'))
      instructions.push(`[macOS installation guide](${base}/blob/${commit}/docs/RELEASING.md#macos-installation)`);
    sections.push([`### ${name}`, rows.join('\n'), instructions.join(' ')].join('\n\n'));
  }
  return sections.length ? ['## Downloads and installation', ...sections].join('\n\n') : '';
}

function verification(assets, link) {
  const sums = link(sumsName);
  if (!sums) return '';
  const certificate = assets.find(({ filename }) => filename === windowsCertificateName);
  const signature = link(signatureName, 'Manifest signature');
  const links = [link(manifestName, 'Release manifest'), signature,
    link(sbomName, 'Software bill of materials')].filter(Boolean);
  const details = [];
  if (assets.some(({ signing, notarized }) => signing === 'ad-hoc' && notarized === false))
    details.push('- macOS packages are ad hoc signed and unnotarized. macOS may ask you to approve Aria in Privacy & Security.');
  if (certificate && assets.some(({ platform }) => platform === 'windows')) {
    details.push(`- Windows packages use Aria’s self-signed Authenticode certificate. Managed devices may require administrator-configured trust. ${link(certificate.filename, 'Public signing certificate')} · SHA-256 \`${certificate.sha256}\``);
  }
  const instructions = `Compare each download’s SHA-256 digest with ${sums}.`;
  return ['## Checksums and verification', [instructions,
    signature ? 'The release manifest carries an Ed25519 signature.' : ''].filter(Boolean).join(' '),
    links.join(' · '), details.join('\n')].filter(Boolean).join('\n\n');
}

export function formatNotes({ commits, pulls, previousTag, commit, tag, compareTarget = tag, version, channel, buildTimestamp,
  license = {}, assets = [], verified = [] }) {
  const uploaded = new Set(verified.map(({ name }) => name));
  // Use the reserved public tag for URLs while the verified uploads are still on the draft.
  const link = (name, label = name) => uploaded.has(name) ? `[${label}](${downloadUrl(tag, name)})` : '';
  const included = assets.filter(({ filename }) => uploaded.has(filename));
  const contributors = [...new Set(pulls.filter((pull) => !skipNotes(pull)).map(({ user }) => user))]
    .filter((login) => /^[a-z\d-]{1,39}$/i.test(login ?? '')).sort();
  const blob = (file) => `${base}/blob/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const licenseLinks = (license.files ?? []).map((file) => `[${plain(file)}](${blob(file)})`);
  const terms = license.declaration && !license.declaration.startsWith('SEE LICENSE IN ')
    ? plain(license.declaration) : '';
  const licenseLines = [
    [terms, ...licenseLinks].filter(Boolean).join(' · '),
    license.notices ? `[Third-party notices](${blob(license.notices)})` : '',
  ].filter(Boolean);
  const values = {
    highlights: highlights(commits, pulls),
    downloads: downloads(included, link, commit),
    verification: verification(included, link),
    version, tag, date: releaseDate(tag),
    channel: channel === 'beta' ? 'Beta prerelease' : 'Stable',
    source: `[\`${commit}\`](${base}/commit/${commit})`,
    build: buildTimestamp ? `| Verified build (UTC) | \`${buildTimestamp}\` |\n` : '',
    license: licenseLines.length ? `## Licensing and notices\n\n${licenseLines.join('\n\n')}` : '',
    contributors: contributors.length ? `## Contributors\n\n${contributors.map((login) =>
      `[@${login}](https://github.com/${login})`).join(', ')}` : '',
    changelog: previousTag
      ? `[Compare changes since ${plain(previousTag)}](${base}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(compareTarget)})`
      : `[Browse commit history](${base}/commits/${commit})`,
  };
  return template.replace(/{{(\w+)}}/g, (_token, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown release notes placeholder: ${key}`);
    return values[key];
  }).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
