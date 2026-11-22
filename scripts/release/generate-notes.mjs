import { repository } from './generate-metadata.mjs';

const headings = {
  breaking: '💥 Breaking Changes',
  security: '🔒 Security',
  feature: '✨ New Features',
  improvement: '🚀 Improvements',
  bug: '🐛 Bug Fixes',
  conductor: '🧠 Aria & Conductor',
  desktop: '🖥️ Desktop Experience',
  performance: '⚡ Performance',
  dependencies: '📦 Dependencies',
};

const labelKinds = {
  breaking: ['breaking', 'breaking-change'],
  security: ['security'],
  performance: ['performance', 'perf'],
  conductor: ['conductor', 'aria-conductor'],
  desktop: ['desktop', 'desktop-experience'],
  dependencies: ['dependencies', 'deps'],
  bug: ['bug', 'bugfix', 'fix'],
  feature: ['feature', 'enhancement-feature'],
  improvement: ['improvement', 'enhancement'],
};

function category(title, body, labels) {
  const conventional = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/i.exec(title);
  const type = conventional?.[1]?.toLowerCase();
  const scope = conventional?.[2]?.toLowerCase();
  const names = new Set(labels.map((label) => label.toLowerCase().replaceAll(/\s+/g, '-')));
  const has = (kind) => labelKinds[kind].some((name) => names.has(name));
  if (has('breaking') || conventional?.[3] || /^BREAKING[ -]CHANGE:\s+\S/m.test(body)) return 'breaking';
  if (has('security') || type === 'security' || scope === 'security' && type === 'fix') return 'security';
  if (has('performance') || type === 'perf') return 'performance';
  if (has('conductor') || scope === 'conductor') return 'conductor';
  if (has('desktop') || scope === 'desktop') return 'desktop';
  if (has('dependencies') || type === 'deps' || scope === 'deps' || scope === 'deps-dev') return 'dependencies';
  if (has('bug') || type === 'fix') return 'bug';
  if (has('feature') || type === 'feat') return 'feature';
  if (has('improvement') || type === 'refactor') return 'improvement';
  if (/^(fix|repair|correct|prevent)\s/i.test(title)) return 'bug';
  if (/^(add|introduce|enable|implement|support)\s/i.test(title)) return 'feature';
  if (/^(improve|simplify|clarify|refine)\s/i.test(title)) return 'improvement';
  return undefined;
}

function plain(text) {
  return text.replace(/[\r\n]/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim()
    .replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    .replace(/[\\`*_[\]{}!@|]/g, '\\$&');
}

export function formatNotes({ commits, pulls, nativeNotes = '', previousTag, commit, tag }) {
  const base = `https://github.com/${repository}`;
  const changes = new Map();
  const contributors = new Set();
  const covered = new Set();
  for (const pr of pulls.sort((a, b) => a.number - b.number)) {
    for (const sha of pr.commits) covered.add(sha);
    if (pr.labels.includes('skip-release-notes')) continue;
    if (pr.user) contributors.add(pr.user);
    const body = [pr.body, ...commits.filter((item) => pr.commits.has(item.sha))
      .map((item) => item.body)].join('\n');
    const associated = commits.filter((item) => pr.commits.has(item.sha));
    const kinds = [category(pr.title, body, pr.labels), ...associated
      .map((item) => category(item.title, item.body, []))];
    const kind = kinds.includes('breaking') ? 'breaking' : kinds.find(Boolean);
    if (kind) {
      const entries = changes.get(kind) ?? [];
      const title = /^(feat|fix|refactor|chore)\//i.test(pr.title)
        ? associated.find((item) => category(item.title, item.body, []) === kind)?.title ?? pr.title
        : pr.title;
      entries.push(`- ${plain(title)} ([#${pr.number}](${base}/pull/${pr.number}))`);
      changes.set(kind, entries);
    }
  }
  for (const item of commits) {
    if (covered.has(item.sha)) continue;
    if (item.author) contributors.add(item.author);
    const kind = category(item.title, item.body, []);
    if (!kind) continue;
    const entries = changes.get(kind) ?? [];
    entries.push(`- ${plain(item.title)} ([${item.sha.slice(0, 7)}](${base}/commit/${item.sha}))`);
    changes.set(kind, entries);
  }
  // Native notes can identify first-time contributors. Render only GitHub logins already
  // associated with a merged PR in this range, and keep the rest of the text deterministic.
  for (const match of nativeNotes.matchAll(/@([a-z\d-]{1,39}) made their first contribution in /gi)) {
    const login = pulls.find((pr) => pr.user?.toLowerCase() === match[1].toLowerCase())?.user;
    if (login) contributors.add(login);
  }

  const sections = Object.entries(headings).flatMap(([kind, title]) =>
    changes.has(kind) ? [`## ${title}\n\n${changes.get(kind).join('\n')}`] : []);
  sections.push([
    '## 📥 Installation', '',
    'Download the package for your platform and architecture. Verify it with `SHA256SUMS.txt`.',
    '- **Windows** — Use the NSIS installer or portable EXE. Windows packages use Aria’s self-signed certificate and require trust configured by your administrator for verified in-app updates. Windows may still show SmartScreen warnings or block installation under device policy.',
    `- **macOS** — Both the Apple Silicon and Intel packages are ad hoc signed and unnotarized. Open the verified DMG and move Aria to Applications. For updates, quit Aria before replacing it in Finder. See the [macOS installation guide](${base}/blob/${commit}/docs/RELEASING.md#macos-installation) if macOS asks you to approve the app.`,
    '- **Linux** — Choose DEB for Debian or Ubuntu, RPM for Fedora-compatible systems, or AppImage or TAR.GZ for manual installation.',
  ].join('\n'));
  if (contributors.size) sections.push(`## 👥 Contributors\n\n${[...contributors].sort().map((login) =>
    /^[a-z\d-]{1,39}$/i.test(login) ? `[@${login}](https://github.com/${login})` : plain(login)).join(', ')}`);
  sections.push(`## 🔗 Full Changelog\n\n[${previousTag ? 'Compare changes' : 'Browse commit history'}](${previousTag
    ? `${base}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tag ?? commit)}`
    : `${base}/commits/${commit}`})`);
  return `${sections.join('\n\n')}\n`;
}
