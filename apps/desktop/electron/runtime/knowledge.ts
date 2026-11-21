import { randomUUID } from 'node:crypto';
import {
  executionLimits,
  type DocumentEvidence,
  type MediaAsset,
  type RuntimeArgs,
} from '@aria/shared';
import { RuntimeError, RuntimeStore, digest } from './store';

export type Passage = { text: string; location?: DocumentEvidence['location'] };
export type Extract = (asset: MediaAsset, bytes: Buffer, signal: AbortSignal) => Promise<Passage[]>;
export type SearchFile = { asset: MediaAsset; bytes: Buffer };
const extractorRevision = '1';

export function textPassages(bytes: Uint8Array): Passage[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new RuntimeError('INVALID_ARGUMENT', 'Choose a UTF-8 document.');
  const lines = text.split(/\r?\n/);
  const chunks: Passage[] = [];
  let textBuffer = '';
  let start = 1;
  for (const [index, line] of lines.entries()) {
    if (textBuffer && textBuffer.length + line.length > 1400) {
      chunks.push({ text: textBuffer, location: { kind: 'lines', start, end: index } });
      textBuffer = '';
      start = index + 1;
    }
    if (line.length > 1400) {
      for (let offset = 0; offset < line.length; offset += 1400)
        chunks.push({
          text: line.slice(offset, offset + 1400),
          location: { kind: 'lines', start: index + 1, end: index + 1 },
        });
      start = index + 2;
    } else {
      textBuffer += (textBuffer ? '\n' : '') + line;
    }
  }
  if (textBuffer)
    chunks.push({ text: textBuffer, location: { kind: 'lines', start, end: lines.length } });
  return chunks;
}

export class Knowledge {
  constructor(
    private readonly store: RuntimeStore,
    private readonly extract: Extract,
  ) {}

  async read(file: SearchFile, offset: number, signal: AbortSignal) {
    const passages = await this.extract(file.asset, file.bytes, signal);
    const text = passages.map((item) => item.text).join('\n');
    if (!text.trim())
      throw new RuntimeError('EXECUTION_FAILED', 'The file does not contain extractable text.');
    return {
      text: text.slice(offset, offset + 12_000),
      data: {
        name: file.asset.name,
        version: digest(file.bytes),
        ...(offset + 12_000 < text.length && { nextOffset: offset + 12_000 }),
      },
      privateContent: true,
    };
  }

  async index(
    file: SearchFile,
    owner: { conversation?: string; collection?: string },
    signal: AbortSignal,
  ) {
    const { asset, bytes } = file;
    const version = digest(bytes);
    const db = this.store.db;
    const recordId = owner.collection
      ? `${owner.collection}/${asset.id}`
      : `${owner.conversation}/${asset.id}`;
    const cached = db.prepare('SELECT version, state FROM documents WHERE id = ?').get(recordId);
    if (cached?.version === version && cached.state === extractorRevision) return recordId;
    const extracted = await this.extract(asset, bytes, signal);
    signal.throwIfAborted();
    if (!extracted.some((item) => item.text.trim()))
      throw new RuntimeError('EXECUTION_FAILED', 'No text could be extracted from this document.');
    let characters = 0;
    const chunks: Passage[] = [];
    for (const item of extracted) {
      for (let i = 0; i < item.text.length; i += 1400) {
        const text = item.text.slice(i, i + 1400).trim();
        if (!text) continue;
        characters += text.length;
        if (characters > executionLimits.indexedCharacters)
          throw new RuntimeError(
            'BUDGET_EXCEEDED',
            'This document exceeds the extraction character limit.',
          );
        chunks.push({ text, location: item.location });
      }
    }
    this.store.transaction(() => {
      db.prepare('DELETE FROM documents WHERE id = ?').run(recordId);
      db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)').run(
        recordId,
        owner.conversation ?? null,
        owner.collection ?? null,
        asset.name,
        version,
        extractorRevision,
      );
      const insert = db.prepare(
        'INSERT INTO chunks(document, version, sequence, text, location) VALUES (?, ?, ?, ?, ?)',
      );
      for (const [i, chunk] of chunks.entries())
        insert.run(recordId, version, i, chunk.text, JSON.stringify(chunk.location ?? null));
    });
    return recordId;
  }

  private sparse(ids: string[], input: RuntimeArgs<'knowledge.search'>) {
    const tokens = (
      [input.query, ...(input.alternatives ?? [])].join(' ').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
    ).slice(0, 36);
    if (!tokens.length) return [];
    const query =
      input.mode === 'phrase'
        ? `"${(input.query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).slice(0, 36).join(' ')}"`
        : [...new Set(tokens)].map((word) => `"${word}"`).join(' OR ');
    return this.store.db
      .prepare(
        `
      SELECT c.rowid AS rowid, -bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      JOIN documents d ON d.id = c.document AND d.version = c.version
      WHERE chunks_fts MATCH ? AND d.id IN (${ids.map(() => '?').join(',')})
      ORDER BY rank DESC, c.rowid LIMIT 32
    `,
      )
      .all(query, ...ids)
      .map((row) => ({ id: Number(row.rowid), score: Number(row.rank) }));
  }

  async semantic(
    ids: string[],
    query: string,
    model: string,
    embed: (texts: string[], signal: AbortSignal) => Promise<number[][]>,
    signal: AbortSignal,
  ) {
    if (!ids.length) return [];
    const db = this.store.db;
    const rows = db
      .prepare(
        `
      SELECT c.rowid AS id, substr(c.text, 1, 1400) AS text, e.vector
      FROM chunks c JOIN documents d ON c.document = d.id AND c.version = d.version
      LEFT JOIN embeddings e ON e.chunk = c.rowid AND e.model = ?
      WHERE d.id IN (${ids.map(() => '?').join(',')})
      ORDER BY c.rowid LIMIT 2001
    `,
      )
      .all(model, ...ids);
    const missing = rows.filter((row) => !(row.vector instanceof Uint8Array));
    if (rows.length > 2000 || missing.length > 192)
      throw new RuntimeError(
        'BUDGET_EXCEEDED',
        'The semantic scope exceeds its budget. Select fewer documents.',
      );
    const normalized = (values: number[]) => {
      const norm = Math.hypot(...values);
      if (!norm || !Number.isFinite(norm))
        throw new RuntimeError(
          'EXECUTION_FAILED',
          'The embedding backend returned an invalid vector.',
        );
      return Float32Array.from(values, (value) => value / norm);
    };
    const [target] = await embed([query], signal);
    const queryVector = normalized(target);
    const storeVector = db.prepare('INSERT OR IGNORE INTO embeddings VALUES (?, ?, ?)');
    for (let i = 0; i < missing.length; i += 16) {
      const group = missing.slice(i, i + 16);
      const vectors = await embed(
        group.map((row) => String(row.text)),
        signal,
      );
      signal.throwIfAborted();
      this.store.transaction(() => {
        for (const [index, row] of group.entries()) {
          const vector = normalized(vectors[index]);
          if (vector.length !== queryVector.length)
            throw new RuntimeError('EXECUTION_FAILED', 'The embedding vector dimensions changed.');
          row.vector = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
          storeVector.run(row.id, model, row.vector);
        }
      });
    }
    return rows
      .map((row) => {
        const values = Buffer.from(row.vector as Uint8Array);
        let score = 0;
        if (values.byteLength !== queryVector.length * 4)
          throw new RuntimeError('EXECUTION_FAILED', 'The cached embedding dimensions changed.');
        for (let i = 0; i < queryVector.length; i++)
          score += values.readFloatLE(i * 4) * queryVector[i];
        return { id: Number(row.id), score };
      })
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, 32);
  }

  find(
    conversation: string,
    ids: string[],
    input: RuntimeArgs<'knowledge.search'>,
    semantic?: { id: number; score: number }[],
  ) {
    if ((input.mode === 'semantic' || input.mode === 'hybrid') && !semantic)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'A configured embedding backend is required.',
      );
    if (!ids.length) return [];
    const sparse = input.mode === 'semantic' ? [] : this.sparse(ids, input);
    let ranking = semantic ?? sparse;
    if (input.mode === 'hybrid') {
      const ranks = new Map<number, number>();
      for (const ranked of [sparse, semantic ?? []]) {
        for (const [position, { id }] of ranked.entries())
          ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + position + 1));
      }
      ranking = [...ranks]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || a.id - b.id);
    }
    const limit = input.limit ?? 4;
    const db = this.store.db;
    const rowFor = db.prepare(`
      SELECT d.id AS document, d.name, d.collection, c.version, c.sequence, c.text, c.location
      FROM chunks c JOIN documents d ON c.document = d.id AND d.version = c.version WHERE c.rowid = ?
    `);
    const results: DocumentEvidence[] = [];
    const seen = new Set<string>();
    for (const match of ranking) {
      if (results.length >= limit) break;
      const row = rowFor.get(match.id);
      if (!row || !ids.includes(String(row.document)) || seen.has(String(row.text))) continue;
      seen.add(String(row.text));
      const document = String(row.document);
      const id = randomUUID();
      const neighbors = input.adjacent
        ? db
            .prepare(
              'SELECT sequence, text FROM chunks WHERE document = ? AND version = ? AND sequence IN (?, ?)',
            )
            .all(document, row.version, Number(row.sequence) - 1, Number(row.sequence) + 1)
        : [];
      const nearby = {
        before: neighbors
          .find((item) => Number(item.sequence) < Number(row.sequence))
          ?.text?.toString()
          .slice(-200),
        after: neighbors
          .find((item) => Number(item.sequence) > Number(row.sequence))
          ?.text?.toString()
          .slice(0, 200),
      };
      const evidence: DocumentEvidence = {
        id,
        fileId: document.slice(document.lastIndexOf('/') + 1),
        name: String(row.name),
        version: String(row.version),
        chunkId: digest(`${document}:${row.version}:${row.sequence}`),
        ...(row.collection && { collectionId: String(row.collection) }),
        excerpt: String(row.text),
        ...((nearby.before || nearby.after) && { nearby }),
        query: input.query,
        score: match.score,
        provenance: 'local',
        location: JSON.parse(String(row.location)) ?? undefined,
      };
      db.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)').run(
        id,
        conversation,
        document,
        evidence.version,
        JSON.stringify(evidence),
      );
      results.push(evidence);
    }
    return results;
  }
}
