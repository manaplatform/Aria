import { githubAccount, type GithubAccount, type GithubOperation } from '@aria/shared';
import type { SecretCipher } from '../provider-storage';
import { RuntimeError, RuntimeStore } from '../runtime/store';
import { savedTokens, type SavedTokens } from './github/authorization';

type Row = { id: string; metadata: string; credentials: Uint8Array | null; approved_primary: string | null; grants_primary: string | null };

export class ConnectorStore {
  constructor(private readonly runtime: RuntimeStore, private readonly cipher: SecretCipher, readonly registration: string) {}

  available() { return this.cipher.available(); }

  private get db() { return this.runtime.db; }
  private row(id: string) {
    return this.db.prepare('SELECT * FROM connector_accounts WHERE registration=? AND id=?')
      .get(this.registration, id) as Row | undefined;
  }

  accounts() {
    return this.db.prepare('SELECT metadata FROM connector_accounts WHERE registration=? ORDER BY user LIMIT 12')
      .all(this.registration).map((row) => githubAccount.parse(JSON.parse(String(row.metadata))));
  }
  account(id: string) {
    const row = this.row(id);
    return row && githubAccount.parse(JSON.parse(row.metadata));
  }
  active() {
    return this.db.prepare('SELECT active FROM connector_settings WHERE registration=?').get(this.registration)?.active as string | null | undefined;
  }
  select(id: string | null) {
    this.db.prepare('INSERT INTO connector_settings VALUES (?, ?) ON CONFLICT(registration) DO UPDATE SET active=excluded.active')
      .run(this.registration, id);
  }

  async tokens(id: string): Promise<SavedTokens | undefined> {
    const row = this.row(id);
    if (!row?.credentials) return;
    try {
      if (!await this.available()) throw new Error('unavailable');
      return savedTokens.parse(JSON.parse((await this.cipher.decrypt(Buffer.from(row.credentials))).result));
    } catch {
      throw new RuntimeError('PERMISSION_DENIED', 'Aria could not unlock this GitHub connection. Check your OS credential store or reconnect.');
    }
  }

  async seal(tokens: SavedTokens) {
    if (!await this.available()) throw new RuntimeError('PERMISSION_DENIED', 'GitHub requires an available OS-backed credential store.');
    return this.cipher.encrypt(JSON.stringify(savedTokens.parse(tokens)));
  }

  put(account: GithubAccount, sealed: Buffer) {
    this.runtime.transaction(() => {
      this.db.prepare(`INSERT INTO connector_accounts VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata, credentials=excluded.credentials,
        approved_primary=NULL, grants_primary=NULL`)
        .run(account.id, this.registration, account.userId, JSON.stringify(githubAccount.parse(account)), sealed);
      this.select(account.id);
    });
  }

  rotate(account: GithubAccount, sealed: Buffer) {
    return this.db.prepare("UPDATE connector_accounts SET credentials=? WHERE id=? AND registration=? AND json_extract(metadata, '$.generation')=? AND credentials IS NOT NULL")
      .run(sealed, account.id, this.registration, account.generation).changes === 1;
  }

  update(account: GithubAccount) {
    this.db.prepare('UPDATE connector_accounts SET metadata=? WHERE id=? AND registration=?')
      .run(JSON.stringify(githubAccount.parse(account)), account.id, this.registration);
  }

  approvedPrimary(id: string) { return this.row(id)?.approved_primary; }
  setApprovedPrimary(id: string, primary: string) {
    this.db.prepare('UPDATE connector_accounts SET approved_primary=? WHERE id=? AND registration=?')
      .run(primary, id, this.registration);
  }
  grantsPrimary(id: string) { return this.row(id)?.grants_primary; }
  setGrantsPrimary(id: string, primary: string) {
    this.db.prepare('UPDATE connector_accounts SET grants_primary=? WHERE id=? AND registration=?')
      .run(primary, id, this.registration);
  }

  remove(id: string, revoked?: GithubAccount) {
    this.db.exec('PRAGMA secure_delete = ON');
    this.runtime.transaction(() => {
      if (revoked)
        this.db.prepare('UPDATE connector_accounts SET metadata=?, credentials=NULL, approved_primary=NULL, grants_primary=NULL WHERE id=? AND registration=?')
          .run(JSON.stringify(githubAccount.parse(revoked)), id, this.registration);
      else {
        this.db.prepare('DELETE FROM connector_accounts WHERE id=? AND registration=?').run(id, this.registration);
        this.db.prepare('DELETE FROM connector_activity WHERE connection=?').run(id);
        if (this.active() === id) this.select(null);
      }
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  activity(id: string, repository: number | undefined, operation: GithubOperation, state: string, url?: string) {
    this.runtime.transaction(() => {
      if (!this.row(id)) return;
      this.db.prepare('INSERT INTO connector_activity (connection, repository, operation, state, occurred, url) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, repository ?? null, operation, state, Date.now(), url ?? null);
      this.db.prepare('DELETE FROM connector_activity WHERE connection=? AND id NOT IN (SELECT id FROM connector_activity WHERE connection=? ORDER BY id DESC LIMIT 100)')
        .run(id, id);
    });
  }

  history(id: string) {
    if (!this.row(id)) return [];
    return this.db.prepare('SELECT repository, operation, state, occurred, url FROM connector_activity WHERE connection=? ORDER BY id DESC LIMIT 40')
      .all(id).map((row) => ({
        repository: row.repository === null ? null : Number(row.repository),
        operation: String(row.operation), state: String(row.state), occurred: Number(row.occurred),
        url: row.url === null ? null : String(row.url),
      }));
  }
}
