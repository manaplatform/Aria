import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument, visit } from 'yaml';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import { z } from 'zod';
import { skillSummarySchema, type SkillSummary } from '@aria/shared';

const maxArchive = 8 * 1024 * 1024;
const maxBundle = 32 * 1024 * 1024;
const maxFile = 1024 * 1024;
const maxFiles = 256;
const frontMatter = z.object({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  license: z.string().min(1).max(500).optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string().max(100), z.string().max(1024)).optional(),
  'allowed-tools': z.string().max(2048).optional(),
});

export const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

const blobSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().max(240),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(0).max(maxFile),
  readable: z.boolean(),
});
export const installedSkillSchema = z.strictObject({
  summary: skillSummarySchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  instructions: z.string().uuid(),
  entries: z
    .array(blobSchema)
    .min(1)
    .max(maxFiles + 1),
});
export type InstalledSkill = z.infer<typeof installedSkillSchema>;
type SkillPreview = { manifest: InstalledSkill; entries: Map<string, Buffer> };

function checkedEntry(name: string) {
  const parts = name.split('/');
  if (
    name.length > 240 ||
    parts.length > 10 ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[<>:"\\|?*]/u.test(part) ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part),
    )
  )
    throw new Error('The skill contains an unsafe file path.');
  return name;
}

export async function readSkillFile(file: string, limit = maxFile) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
    throw new Error('Skill files must be regular, unlinked files within the size limit.');
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > limit ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error('The skill changed while it was being imported.');
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new Error('The skill changed while it was being read.');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function decode(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Skill text must use UTF-8.');
  return text;
}

async function directoryEntries(selected: string, add: (name: string, content?: Buffer) => void) {
  const root = await fs.realpath(selected);
  const rootStat = await fs.lstat(selected);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Choose a regular skill directory.');
  const visitDirectory = async (directory: string, prefix = '') => {
    const children = await fs.opendir(directory);
    for await (const child of children) {
      const filename = path.join(directory, child.name);
      const logical = checkedEntry(prefix + child.name);
      const real = await fs.realpath(filename);
      if (path.relative(root, real) !== path.relative(root, filename) || child.isSymbolicLink())
        throw new Error('Skill bundles cannot contain linked entries.');
      if (child.isDirectory()) {
        add(logical);
        await visitDirectory(filename, logical + '/');
      } else {
        const bytes = await readSkillFile(filename);
        if ((await fs.realpath(filename)) !== real)
          throw new Error('The skill path changed while it was being read.');
        add(logical, bytes);
      }
    }
  };
  await visitDirectory(root);
  return path.basename(selected);
}

async function zipEntries(filename: string, add: (name: string, content?: Buffer) => void) {
  const snapshot = await readSkillFile(filename, maxArchive);
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    // Reading the verified snapshot prevents the selected path from changing between checks.
    fromBuffer(
      snapshot,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, archive) => (error ? reject(error) : resolve(archive)),
    );
  });
  let root: string | undefined;
  const next = () =>
    new Promise<Entry | undefined>((resolve, reject) => {
      const cleanup = () => {
        zip.removeListener('error', error);
        zip.removeListener('entry', entry);
        zip.removeListener('end', end);
      };
      const error = (failure: Error) => {
        cleanup();
        reject(failure);
      };
      const entry = (value: Entry) => {
        cleanup();
        resolve(value);
      };
      const end = () => {
        cleanup();
        resolve(undefined);
      };
      zip.once('error', error);
      zip.once('entry', entry);
      zip.once('end', end);
      zip.readEntry();
    });
  try {
    if (zip.entryCount > maxFiles + 1) throw new Error('The skill ZIP contains too many entries.');
    for (let entry = await next(); entry; entry = await next()) {
      const folder = entry.fileName.endsWith('/');
      const [entryRoot, ...parts] = checkedEntry(entry.fileName.replace(/\/$/u, '')).split('/');
      root ??= entryRoot;
      if (root !== entryRoot || (!folder && !parts.length))
        throw new Error('A skill ZIP must contain a single named root directory.');
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (
        (mode && mode !== (folder ? 0o040000 : 0o100000)) ||
        entry.externalFileAttributes & 0x400 ||
        entry.uncompressedSize > maxFile
      )
        throw new Error('The skill ZIP contains an unsupported entry.');
      if (!parts.length) continue;
      const name = parts.join('/');
      if (folder) {
        add(name);
        continue;
      }
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zip.openReadStream(entry!, (error, reader) => (error ? reject(error) : resolve(reader)));
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxFile) throw new Error('The skill ZIP exceeds its expanded file limit.');
        chunks.push(buffer);
      }
      add(name, Buffer.concat(chunks));
    }
  } finally {
    zip.close();
  }
  return root;
}

export async function inspectBundle(
  selected: string,
  kind: 'directory' | 'zip',
): Promise<SkillPreview> {
  const files = new Map<string, Buffer>();
  const observed = new Map<string, { name: string; file: boolean; explicit: boolean }>();
  let total = 0;
  const add = (name: string, content?: Buffer) => {
    const parts = checkedEntry(name).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.normalize('NFKC').toLowerCase();
      const last = i === parts.length;
      const previous = observed.get(key);
      if (
        previous &&
        (previous.name !== prefix ||
          previous.file ||
          (last && (previous.explicit || content !== undefined)))
      )
        throw new Error('The skill contains conflicting or duplicate file paths.');
      if (!previous || last)
        observed.set(key, { name: prefix, file: last && content !== undefined, explicit: last });
    }
    if (observed.size > maxFiles) throw new Error('The skill bundle has too many entries.');
    if (!content) return;
    total += content.length;
    if (total > maxBundle) throw new Error('The skill exceeds its expanded size limit.');
    files.set(name, content);
  };
  const root =
    kind === 'directory' ? await directoryEntries(selected, add) : await zipEntries(selected, add);
  const manifest = files.get('SKILL.md');
  if (!manifest || manifest.length > 32 * 1024)
    throw new Error('Include a SKILL.md manifest within the size limit.');
  const source = decode(manifest).replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(source);
  if (!match) throw new Error('SKILL.md requires a YAML front matter block.');
  const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
  visit(document, {
    Node: (_, node) => {
      if (node.tag || node.anchor)
        throw new Error('Use plain YAML metadata without tags or anchors.');
    },
  });
  if (document.errors.length || document.warnings.length)
    throw new Error('SKILL.md contains invalid YAML metadata.');
  const metadata = frontMatter.parse(document.toJS({ maxAliasCount: 0 }));
  const body = match[2].trim();
  if (metadata.name !== root || !body || body.length > 12_000)
    throw new Error(
      'The skill name must match its folder, and instructions must fit within 12,000 characters.',
    );
  const entries = [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => {
      const readable = /^(references|assets)\/.+\.(md|txt|csv|tsv|json|yaml|yml)$/iu.test(name);
      if (readable) decode(bytes);
      return {
        id: randomUUID(),
        name,
        digest: hash(bytes),
        bytes: bytes.length,
        readable,
      };
    });
  const digest = hash(JSON.stringify(entries.map(({ name, digest }) => [name, digest])));
  const instructions = randomUUID();
  const instructionBytes = Buffer.from(body);
  const summary: SkillSummary = {
    id: `skills.local_${metadata.name.replaceAll('-', '_')}`,
    version: digest,
    name: metadata.name,
    description: metadata.description,
    compatibility: metadata.compatibility,
    dependencies: (metadata.metadata?.['aria.dependencies'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 32)
      .map((value) => value.slice(0, 100)),
    provenance: 'local',
    enabled: true,
  };
  entries.push({
    id: instructions,
    name: 'Instructions',
    digest: hash(instructionBytes),
    bytes: instructionBytes.length,
    readable: false,
  });
  const contents = new Map(
    entries.map((entry) => [
      entry.id,
      entry.id === instructions ? instructionBytes : files.get(entry.name)!,
    ]),
  );
  return {
    manifest: installedSkillSchema.parse({ summary, digest, instructions, entries }),
    entries: contents,
  };
}

export function decodeSkillText(content: Buffer) {
  return decode(content);
}
