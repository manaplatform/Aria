import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KnowledgeCollection } from '@aria/shared';
import { MediaStorage } from '../media-storage';
import { RuntimeError, RuntimeStore, digest } from './store';

export class DocumentLibrary {
  private readonly files: MediaStorage;

  constructor(
    profile: string,
    private readonly store: RuntimeStore,
  ) {
    this.files = new MediaStorage(path.join(profile, 'library'));
  }

  list(enabledOnly = false): KnowledgeCollection[] {
    const db = this.store.db;
    const docs = db.prepare(
      'SELECT id, name, state FROM documents WHERE collection = ? ORDER BY name',
    );
    return db
      .prepare(
        'SELECT id, name, enabled FROM collections WHERE enabled = 1 OR ? = 0 ORDER BY created',
      )
      .all(Number(enabledOnly))
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        enabled: Boolean(row.enabled),
        files: docs.all(row.id).map((item) => ({
          id: String(item.id).slice(String(item.id).lastIndexOf('/') + 1),
          name: String(item.name),
          status: item.state === 'queued' ? 'queued' : 'ready',
        })),
      }));
  }

  create(name: string) {
    const db = this.store.db;
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM collections').get()?.count) >= 25)
      throw new Error('Remove a collection before creating another.');
    db.prepare('INSERT INTO collections(id, name, created) VALUES (?, ?, ?)').run(
      randomUUID(),
      name,
      Date.now(),
    );
  }

  enable(id: string, enabled: boolean) {
    this.store.db
      .prepare('UPDATE collections SET enabled = ? WHERE id = ?')
      .run(Number(enabled), id);
  }

  async add(id: string, filenames: string[]) {
    const db = this.store.db;
    if (!db.prepare('SELECT 1 FROM collections WHERE id = ?').get(id))
      throw new Error('The document collection no longer exists.');
    if (
      filenames.length > 16 ||
      Number(
        db.prepare('SELECT COUNT(*) AS count FROM documents WHERE collection = ?').get(id)?.count,
      ) +
        filenames.length >
        64
    )
      throw new Error('Each collection can hold up to 64 documents. Import up to 16 at a time.');
    const files = [];
    try {
      for (const filename of filenames) {
        const asset = await this.files.import(filename, 'any');
        files.push(asset);
        if (
          asset.mimeType !== 'text/plain' &&
          (!asset.mimeType.startsWith('application/') || asset.mimeType === 'application/zip')
        )
          throw new Error('Select a supported text, PDF, or Office document.');
      }
      const loaded = await Promise.all(files.map((asset) => this.files.get(asset.id)));
      this.store.transaction(() => {
        const insert = db.prepare("INSERT INTO documents VALUES (?, NULL, ?, ?, ?, 'queued')");
        for (const { asset, bytes } of loaded)
          insert.run(`${id}/${asset.id}`, id, asset.name, digest(bytes));
      });
    } catch (error) {
      await Promise.allSettled(files.map((asset) => this.files.remove(asset.id)));
      throw error;
    }
  }

  async remove(id: string, assetId?: string) {
    const db = this.store.db;
    const docs = db
      .prepare('SELECT id FROM documents WHERE collection = ? AND (? IS NULL OR id = ?)')
      .all(id, assetId ?? null, `${id}/${assetId}`);
    this.store.transaction(() => {
      if (assetId)
        db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?').run(
          id,
          `${id}/${assetId}`,
        );
      else db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    });
    await Promise.allSettled(
      docs.map((doc) => this.files.remove(String(doc.id).slice(id.length + 1))),
    );
  }

  get(collectionId: string, assetId: string) {
    if (
      !this.store.db
        .prepare(
          `
      SELECT 1 FROM documents d JOIN collections c ON c.id = d.collection
      WHERE d.id = ? AND d.collection = ? AND c.enabled = 1
    `,
        )
        .get(`${collectionId}/${assetId}`, collectionId)
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'This document collection is not authorized for chat.',
      );
    return this.files.get(assetId);
  }
}
