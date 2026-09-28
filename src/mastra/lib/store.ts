import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type Client } from '@libsql/client';

import { resolveDatabaseUrl } from '../config';
import type { Evidence, NormalizedContent } from './content';

/** Prepare local directories only; remote and in-memory URLs do not touch the filesystem. */
export function ensureDatabaseDirectory(url: string) {
  if (url.startsWith('file:') && url !== 'file::memory:') {
    mkdirSync(dirname(fileURLToPath(resolveDatabaseUrl(url, process.cwd()))), { recursive: true });
  }
}

export type Snapshot = {
  id: string;
  monitorId: string;
  sourceId: string;
  sourceUrl: string;
  content: NormalizedContent;
  acquisition?: SnapshotAcquisition;
  createdAt: string;
};

export type SnapshotAcquisition = {
  mode: 'http';
  finalUrl: string;
  status: number;
  durationMs: number;
  retries: number;
};

export type StoredRun = {
  id: string;
  monitorId: string;
  status: 'running' | 'success' | 'partial' | 'failed';
  startedAt: string;
};

export class MonitorStore {
  private initialized = false;
  private initializing?: Promise<void>;

  constructor(readonly client: Client) {}

  static open(url: string) {
    ensureDatabaseDirectory(url);
    return new MonitorStore(createClient({ url }));
  }

  async init() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize();
    try {
      await this.initializing;
      this.initialized = true;
    } finally {
      this.initializing = undefined;
    }
  }

  private async initialize() {
    await this.client.executeMultiple(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS monitor_sources (
        monitor_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        normalization_profile TEXT NOT NULL,
        baseline_snapshot_id TEXT,
        PRIMARY KEY (monitor_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        acquisition_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        monitor_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        before_snapshot_id TEXT NOT NULL,
        after_snapshot_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL,
        UNIQUE (monitor_id, source_id, before_snapshot_id, after_snapshot_id, id)
      );
      CREATE TABLE IF NOT EXISTS monitor_runs (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS monitor_locks (
        monitor_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_outcomes (
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (run_id, source_id)
      );
    `);
    // Older F1 databases store only normalized content. Keep those immutable rows readable and add
    // optional metadata for new snapshots instead of rebuilding or rewriting the table.
    const snapshotColumns = await this.client.execute('PRAGMA table_info(snapshots)');
    if (!snapshotColumns.rows.some(row => String(row.name) === 'acquisition_json')) {
      await this.client.execute('ALTER TABLE snapshots ADD COLUMN acquisition_json TEXT');
    }
    await this.client.batch(
      [
        {
          sql: "UPDATE monitor_runs SET status = 'partial', completed_at = ? WHERE status = 'running'",
          args: [new Date().toISOString()],
        },
        { sql: 'DELETE FROM monitor_locks', args: [] },
      ],
      'write',
    );
  }

  async beginRun(monitorId: string): Promise<StoredRun> {
    await this.init();
    const run = { id: randomUUID(), monitorId, status: 'running' as const, startedAt: new Date().toISOString() };
    try {
      await this.client.batch(
        [
          {
            sql: 'INSERT INTO monitor_runs (id, monitor_id, status, started_at) VALUES (?, ?, ?, ?)',
            args: [run.id, run.monitorId, run.status, run.startedAt],
          },
          { sql: 'INSERT INTO monitor_locks (monitor_id, run_id) VALUES (?, ?)', args: [monitorId, run.id] },
        ],
        'write',
      );
      return run;
    } catch (error) {
      if (/constraint|unique/i.test(error instanceof Error ? error.message : '')) throw new Error('MONITOR_BUSY');
      throw error;
    }
  }

  async finishRun(run: StoredRun, status: 'success' | 'partial' | 'failed', result: unknown) {
    await this.client.batch(
      [
        {
          sql: 'UPDATE monitor_runs SET status = ?, completed_at = ?, result_json = ? WHERE id = ?',
          args: [status, new Date().toISOString(), JSON.stringify(result), run.id],
        },
        { sql: 'DELETE FROM monitor_locks WHERE monitor_id = ? AND run_id = ?', args: [run.monitorId, run.id] },
      ],
      'write',
    );
  }

  async baseline(monitorId: string, sourceId: string) {
    await this.init();
    const result = await this.client.execute({
      sql: `SELECT s.* FROM monitor_sources ms JOIN snapshots s ON s.id = ms.baseline_snapshot_id
            WHERE ms.monitor_id = ? AND ms.source_id = ?`,
      args: [monitorId, sourceId],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    return this.rowToSnapshot(row);
  }

  async sourceIdentity(monitorId: string, sourceId: string) {
    const result = await this.client.execute({
      sql: 'SELECT source_url, normalization_profile FROM monitor_sources WHERE monitor_id = ? AND source_id = ?',
      args: [monitorId, sourceId],
    });
    const row = result.rows[0];
    return row ? { url: String(row.source_url), profile: String(row.normalization_profile) } : undefined;
  }

  async persistAcceptedSnapshot(input: {
    runId: string;
    monitorId: string;
    sourceId: string;
    sourceUrl: string;
    normalizationProfile: string;
    content: NormalizedContent;
    acquisition?: SnapshotAcquisition;
    beforeSnapshot?: Snapshot;
    evidence: Evidence[];
    promoteBaseline: boolean;
    warnings?: string[];
  }) {
    const snapshot: Snapshot = {
      id: randomUUID(),
      monitorId: input.monitorId,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      content: input.content,
      acquisition: input.acquisition,
      createdAt: new Date().toISOString(),
    };
    const statements = [
      {
        sql: `INSERT INTO monitor_sources (monitor_id, source_id, source_url, normalization_profile, baseline_snapshot_id)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(monitor_id, source_id) DO UPDATE SET baseline_snapshot_id = excluded.baseline_snapshot_id`,
        args: [
          input.monitorId,
          input.sourceId,
          input.sourceUrl,
          input.normalizationProfile,
          input.promoteBaseline ? snapshot.id : (input.beforeSnapshot?.id ?? null),
        ],
      },
      {
        sql: `INSERT INTO snapshots
              (id, monitor_id, source_id, source_url, content_json, content_hash, acquisition_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          snapshot.id,
          snapshot.monitorId,
          snapshot.sourceId,
          snapshot.sourceUrl,
          JSON.stringify(snapshot.content),
          snapshot.content.hash,
          snapshot.acquisition ? JSON.stringify(snapshot.acquisition) : null,
          snapshot.createdAt,
        ],
      },
      ...input.evidence.map(item => {
        const candidateId = `${input.beforeSnapshot!.id}:${snapshot.id}:${item.id}`;
        return {
          sql: `INSERT OR IGNORE INTO pending_evidence
              (id, run_id, monitor_id, source_id, before_snapshot_id, after_snapshot_id, evidence_json, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          args: [
            candidateId,
            input.runId,
            input.monitorId,
            input.sourceId,
            input.beforeSnapshot!.id,
            snapshot.id,
            JSON.stringify({ ...item, id: candidateId }),
          ],
        };
      }),
      {
        sql: 'INSERT OR REPLACE INTO source_outcomes (run_id, source_id, status, detail_json) VALUES (?, ?, ?, ?)',
        args: [
          input.runId,
          input.sourceId,
          input.evidence.length ? 'pending' : 'accepted',
          JSON.stringify({ snapshotId: snapshot.id, warnings: input.warnings ?? [] }),
        ],
      },
    ];
    await this.client.batch(statements, 'write');
    return snapshot;
  }

  /** Stores an acquired suspect page for review without changing the accepted source baseline. */
  async persistQuarantinedSnapshot(input: {
    runId: string;
    monitorId: string;
    sourceId: string;
    sourceUrl: string;
    content: NormalizedContent;
    acquisition: SnapshotAcquisition;
    code: string;
    reason: Record<string, number>;
  }) {
    await this.init();
    const snapshot: Snapshot = {
      id: randomUUID(),
      monitorId: input.monitorId,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      content: input.content,
      acquisition: input.acquisition,
      createdAt: new Date().toISOString(),
    };
    await this.client.batch(
      [
        {
          sql: `INSERT INTO snapshots
                (id, monitor_id, source_id, source_url, content_json, content_hash, acquisition_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            snapshot.id,
            snapshot.monitorId,
            snapshot.sourceId,
            snapshot.sourceUrl,
            JSON.stringify(snapshot.content),
            snapshot.content.hash,
            JSON.stringify(snapshot.acquisition),
            snapshot.createdAt,
          ],
        },
        {
          sql: 'INSERT OR REPLACE INTO source_outcomes (run_id, source_id, status, detail_json) VALUES (?, ?, ?, ?)',
          args: [
            input.runId,
            input.sourceId,
            'quarantined',
            JSON.stringify({ code: input.code, snapshotId: snapshot.id, reason: input.reason }),
          ],
        },
      ],
      'write',
    );
    return snapshot;
  }

  async pendingForRun(runId: string) {
    const result = await this.client.execute({
      sql: 'SELECT * FROM pending_evidence WHERE run_id = ? AND status = ?',
      args: [runId, 'pending'],
    });
    return result.rows.map(row => JSON.parse(String(row.evidence_json)) as Evidence);
  }

  async pendingIdsForSource(monitorId: string, sourceId: string) {
    const result = await this.client.execute({
      sql: 'SELECT id FROM pending_evidence WHERE monitor_id = ? AND source_id = ? AND status = ?',
      args: [monitorId, sourceId, 'pending'],
    });
    return result.rows.map(row => String(row.id));
  }

  async pendingWarningsForSource(monitorId: string, sourceId: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: `SELECT DISTINCT o.detail_json FROM source_outcomes o
            JOIN pending_evidence p ON p.run_id = o.run_id AND p.source_id = o.source_id
            WHERE p.monitor_id = ? AND p.source_id = ? AND p.status = 'pending'`,
      args: [monitorId, sourceId],
    });
    return [
      ...new Set(
        result.rows.flatMap(row => {
          const detail = JSON.parse(String(row.detail_json));
          return (detail.warnings ?? []).filter((warning: unknown) => warning === 'CANDIDATE_LIMIT') as string[];
        }),
      ),
    ];
  }

  async recordSourceOutcome(
    runId: string,
    sourceId: string,
    status: 'accepted' | 'failed' | 'quarantined',
    detail: unknown,
  ) {
    await this.client.execute({
      sql: 'INSERT OR REPLACE INTO source_outcomes (run_id, source_id, status, detail_json) VALUES (?, ?, ?, ?)',
      args: [runId, sourceId, status, JSON.stringify(detail)],
    });
  }

  async close() {
    this.client.close();
  }

  private rowToSnapshot(row: Record<string, unknown>): Snapshot {
    return {
      id: String(row.id),
      monitorId: String(row.monitor_id),
      sourceId: String(row.source_id),
      sourceUrl: String(row.source_url),
      content: JSON.parse(String(row.content_json)) as NormalizedContent,
      acquisition: row.acquisition_json ? (JSON.parse(String(row.acquisition_json)) as SnapshotAcquisition) : undefined,
      createdAt: String(row.created_at),
    };
  }
}
