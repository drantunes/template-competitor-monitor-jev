import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type Client } from '@libsql/client';

import { CLASSIFICATION_LIMITS, resolveDatabaseUrl } from '../config';
import type { ClassificationDecision } from './classification';
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
  mode: 'http' | 'browser';
  finalUrl: string;
  status: number;
  durationMs: number;
  retries: number;
  fallbackReason?: 'explicit_browser' | 'short_content' | 'selector_missing' | 'client_render_placeholder';
};

export type StoredRun = {
  id: string;
  monitorId: string;
  status: 'running' | 'success' | 'partial' | 'failed';
  startedAt: string;
  nativeWorkflowRunId?: string;
};

export type PendingCandidate = Evidence & {
  candidateId: string;
  monitorId: string;
  sourceId: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
};

export type StoredClassification = {
  questionSetVersion: string;
  ruleVersion: string;
  decision: ClassificationDecision;
  audit: Record<string, unknown>;
};

// Startup recovery belongs to the local database, not to each client handle in this process.
const localDatabaseOwners = new Map<string, { owners: Set<MonitorStore>; recovery?: Promise<void> }>();

export class MonitorStore {
  private initialized = false;
  private initializing?: Promise<void>;

  private constructor(
    readonly client: Client,
    private readonly localDatabasePath?: string,
  ) {}

  static open(url: string) {
    ensureDatabaseDirectory(url);
    const localDatabasePath =
      url.startsWith('file:') && url !== 'file::memory:'
        ? fileURLToPath(resolveDatabaseUrl(url, process.cwd()))
        : undefined;
    const store = new MonitorStore(createClient({ url }), localDatabasePath);
    if (localDatabasePath) {
      const entry = localDatabaseOwners.get(localDatabasePath) ?? { owners: new Set<MonitorStore>() };
      entry.owners.add(store);
      localDatabaseOwners.set(localDatabasePath, entry);
    }
    return store;
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
        native_workflow_run_id TEXT,
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
      CREATE TABLE IF NOT EXISTS classification_decisions (
        candidate_id TEXT NOT NULL,
        question_set_version TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, question_set_version, rule_version)
      );
      CREATE TABLE IF NOT EXISTS provider_reservations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        amount_units INTEGER NOT NULL,
        known_amount_units INTEGER,
        unresolved_units INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Older F1 databases store only normalized content. Keep those immutable rows readable and add
    // optional metadata for new snapshots instead of rebuilding or rewriting the table.
    const snapshotColumns = await this.client.execute('PRAGMA table_info(snapshots)');
    if (!snapshotColumns.rows.some(row => String(row.name) === 'acquisition_json')) {
      await this.client.execute('ALTER TABLE snapshots ADD COLUMN acquisition_json TEXT');
    }
    const runColumns = await this.client.execute('PRAGMA table_info(monitor_runs)');
    if (!runColumns.rows.some(row => String(row.name) === 'native_workflow_run_id')) {
      await this.client.execute('ALTER TABLE monitor_runs ADD COLUMN native_workflow_run_id TEXT');
    }
    const entry = this.localDatabasePath ? localDatabaseOwners.get(this.localDatabasePath) : undefined;
    if (entry) {
      if (!entry.recovery) {
        const recovery = this.recoverInterruptedRuns();
        entry.recovery = recovery;
        void recovery.catch(() => {
          if (entry.recovery === recovery) entry.recovery = undefined;
        });
      }
      await entry.recovery;
    } else {
      await this.recoverInterruptedRuns();
    }
  }

  private async recoverInterruptedRuns() {
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

  async beginRun(monitorId: string, nativeWorkflowRunId?: string): Promise<StoredRun> {
    await this.init();
    const run = {
      id: randomUUID(),
      monitorId,
      status: 'running' as const,
      startedAt: new Date().toISOString(),
      nativeWorkflowRunId,
    };
    try {
      await this.client.batch(
        [
          {
            sql: 'INSERT INTO monitor_runs (id, monitor_id, status, started_at, native_workflow_run_id) VALUES (?, ?, ?, ?, ?)',
            args: [run.id, run.monitorId, run.status, run.startedAt, run.nativeWorkflowRunId ?? null],
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
          sql: "UPDATE monitor_runs SET status = ?, completed_at = ?, result_json = ? WHERE id = ? AND status = 'running'",
          args: [status, new Date().toISOString(), JSON.stringify(result), run.id],
        },
        { sql: 'DELETE FROM monitor_locks WHERE monitor_id = ? AND run_id = ?', args: [run.monitorId, run.id] },
      ],
      'write',
    );
  }

  /** Operator-safe join key for native schedule trigger history. */
  async runForNativeWorkflowRunId(nativeWorkflowRunId: string) {
    await this.init();
    const result = await this.client.execute({
      sql: `SELECT id, monitor_id, status, started_at, completed_at
            FROM monitor_runs WHERE native_workflow_run_id = ?`,
      args: [nativeWorkflowRunId],
    });
    const row = result.rows[0];
    return row
      ? {
          runId: String(row.id),
          monitorId: String(row.monitor_id),
          status: String(row.status),
          startedAt: String(row.started_at),
          completedAt: row.completed_at ? String(row.completed_at) : undefined,
        }
      : undefined;
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
    const runIsActive = "EXISTS (SELECT 1 FROM monitor_runs WHERE id = ? AND status = 'running')";
    const statements = [
      {
        sql: `INSERT INTO monitor_sources (monitor_id, source_id, source_url, normalization_profile, baseline_snapshot_id)
              SELECT ?, ?, ?, ?, ? WHERE ${runIsActive}
              ON CONFLICT(monitor_id, source_id) DO UPDATE SET baseline_snapshot_id = excluded.baseline_snapshot_id`,
        args: [
          input.monitorId,
          input.sourceId,
          input.sourceUrl,
          input.normalizationProfile,
          input.promoteBaseline ? snapshot.id : (input.beforeSnapshot?.id ?? null),
          input.runId,
        ],
      },
      {
        sql: `INSERT INTO snapshots
              (id, monitor_id, source_id, source_url, content_json, content_hash, acquisition_json, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${runIsActive}`,
        args: [
          snapshot.id,
          snapshot.monitorId,
          snapshot.sourceId,
          snapshot.sourceUrl,
          JSON.stringify(snapshot.content),
          snapshot.content.hash,
          snapshot.acquisition ? JSON.stringify(snapshot.acquisition) : null,
          snapshot.createdAt,
          input.runId,
        ],
      },
      ...input.evidence.map(item => {
        const candidateId = `${input.beforeSnapshot!.id}:${snapshot.id}:${item.id}`;
        return {
          sql: `INSERT OR IGNORE INTO pending_evidence
              (id, run_id, monitor_id, source_id, before_snapshot_id, after_snapshot_id, evidence_json, status)
              SELECT ?, ?, ?, ?, ?, ?, ?, 'pending' WHERE ${runIsActive}`,
          args: [
            candidateId,
            input.runId,
            input.monitorId,
            input.sourceId,
            input.beforeSnapshot!.id,
            snapshot.id,
            JSON.stringify({ ...item, id: candidateId }),
            input.runId,
          ],
        };
      }),
      {
        sql: `INSERT OR REPLACE INTO source_outcomes (run_id, source_id, status, detail_json)
              SELECT ?, ?, ?, ? WHERE ${runIsActive}`,
        args: [
          input.runId,
          input.sourceId,
          input.evidence.length ? 'pending' : 'accepted',
          JSON.stringify({ snapshotId: snapshot.id, warnings: input.warnings ?? [] }),
          input.runId,
        ],
      },
    ];
    const results = await this.client.batch(statements, 'write');
    if (!results[1]?.rowsAffected) throw new Error('RUN_CANCELED');
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
    const runIsActive = "EXISTS (SELECT 1 FROM monitor_runs WHERE id = ? AND status = 'running')";
    const results = await this.client.batch(
      [
        {
          sql: `INSERT INTO snapshots
                (id, monitor_id, source_id, source_url, content_json, content_hash, acquisition_json, created_at)
                SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${runIsActive}`,
          args: [
            snapshot.id,
            snapshot.monitorId,
            snapshot.sourceId,
            snapshot.sourceUrl,
            JSON.stringify(snapshot.content),
            snapshot.content.hash,
            JSON.stringify(snapshot.acquisition),
            snapshot.createdAt,
            input.runId,
          ],
        },
        {
          sql: `INSERT OR REPLACE INTO source_outcomes (run_id, source_id, status, detail_json)
                SELECT ?, ?, ?, ? WHERE ${runIsActive}`,
          args: [
            input.runId,
            input.sourceId,
            'quarantined',
            JSON.stringify({ code: input.code, snapshotId: snapshot.id, reason: input.reason }),
            input.runId,
          ],
        },
      ],
      'write',
    );
    if (!results[0]?.rowsAffected) throw new Error('RUN_CANCELED');
    return snapshot;
  }

  async pendingForRun(runId: string) {
    const result = await this.client.execute({
      sql: 'SELECT * FROM pending_evidence WHERE run_id = ? AND status = ?',
      args: [runId, 'pending'],
    });
    return result.rows.map(row => JSON.parse(String(row.evidence_json)) as Evidence);
  }

  async evidence(candidateId: string) {
    const result = await this.client.execute({
      sql: `SELECT p.evidence_json, s.source_url FROM pending_evidence p
            JOIN snapshots s ON s.id = p.after_snapshot_id WHERE p.id = ?`,
      args: [candidateId],
    });
    const row = result.rows[0];
    return row
      ? { evidence: JSON.parse(String(row.evidence_json)) as Evidence, sourceUrl: String(row.source_url) }
      : undefined;
  }

  async pendingIdsForSource(monitorId: string, sourceId: string) {
    const result = await this.client.execute({
      sql: 'SELECT id FROM pending_evidence WHERE monitor_id = ? AND source_id = ? AND status = ?',
      args: [monitorId, sourceId, 'pending'],
    });
    return result.rows.map(row => String(row.id));
  }

  async pendingCandidatesForSource(monitorId: string, sourceId: string): Promise<PendingCandidate[]> {
    await this.init();
    const result = await this.client.execute({
      sql: `SELECT id, monitor_id, source_id, before_snapshot_id, after_snapshot_id, evidence_json
            FROM pending_evidence WHERE monitor_id = ? AND source_id = ? AND status = 'pending' ORDER BY id`,
      args: [monitorId, sourceId],
    });
    return result.rows.map(row => ({
      ...(JSON.parse(String(row.evidence_json)) as Evidence),
      candidateId: String(row.id),
      monitorId: String(row.monitor_id),
      sourceId: String(row.source_id),
      beforeSnapshotId: String(row.before_snapshot_id),
      afterSnapshotId: String(row.after_snapshot_id),
    }));
  }

  /** Atomically reserves the full bounded native-call allowance. Reservations remain on uncertain billing. */
  async reserveProviderBudget(input: {
    provider: 'jev' | 'openai';
    candidateId: string;
    amountUsd: number;
    ceilingUsd: number;
  }) {
    await this.init();
    const id = randomUUID();
    const amountUnits = Math.ceil(input.amountUsd * CLASSIFICATION_LIMITS.usdReservationUnits);
    const ceilingUnits = Math.floor(input.ceilingUsd * CLASSIFICATION_LIMITS.usdReservationUnits);
    const result = await this.client.execute({
      sql: `INSERT INTO provider_reservations (id, provider, candidate_id, amount_units, unresolved_units, status, created_at)
            SELECT ?, ?, ?, ?, ?, 'uncertain', ?
            WHERE COALESCE((SELECT SUM(COALESCE(known_amount_units + unresolved_units, amount_units)) FROM provider_reservations WHERE provider = ?), 0) + ? <= ?`,
      args: [
        id,
        input.provider,
        input.candidateId,
        amountUnits,
        amountUnits,
        new Date().toISOString(),
        input.provider,
        amountUnits,
        ceilingUnits,
      ],
    });
    return result.rowsAffected > 0 ? id : undefined;
  }

  /** Release only a reservation made before an evaluation was dispatched. Attempted calls remain uncertain. */
  async releaseUnattemptedProviderReservation(id: string) {
    await this.client.execute({
      sql: `DELETE FROM provider_reservations
            WHERE id = ? AND status = 'uncertain' AND known_amount_units IS NULL AND unresolved_units = amount_units`,
      args: [id],
    });
  }

  /** Record completed provider usage only when all billed components are known within the original reservation. */
  async settleProviderReservation(input: { id: string; knownAmountUnits: number; unresolvedUnits: number }) {
    await this.init();
    if (
      !Number.isSafeInteger(input.knownAmountUnits) ||
      !Number.isSafeInteger(input.unresolvedUnits) ||
      input.knownAmountUnits < 0 ||
      input.unresolvedUnits < 0
    ) {
      throw new Error('INVALID_PROVIDER_RESERVATION_SETTLEMENT');
    }
    const result = await this.client.execute({
      sql: `UPDATE provider_reservations
            SET known_amount_units = ?, unresolved_units = ?, status = CASE WHEN ? = 0 THEN 'settled' ELSE 'uncertain' END
            WHERE id = ? AND status = 'uncertain' AND known_amount_units IS NULL AND unresolved_units = amount_units
              AND ? + ? <= amount_units`,
      args: [
        input.knownAmountUnits,
        input.unresolvedUnits,
        input.unresolvedUnits,
        input.id,
        input.knownAmountUnits,
        input.unresolvedUnits,
      ],
    });
    return result.rowsAffected > 0;
  }

  async commitClassification(input: {
    candidateId: string;
    questionSetVersion: string;
    decision: ClassificationDecision;
    audit: Record<string, unknown>;
    reservationId?: string;
    knownUsageUsd?: number;
    unresolvedUsageUsd?: number;
  }) {
    await this.init();
    const settlement =
      input.reservationId && input.knownUsageUsd !== undefined && input.unresolvedUsageUsd !== undefined
        ? [
            {
              sql: 'UPDATE provider_reservations SET known_amount_units = ?, unresolved_units = ? WHERE id = ?',
              args: [
                Math.ceil(input.knownUsageUsd * CLASSIFICATION_LIMITS.usdReservationUnits),
                Math.ceil(input.unresolvedUsageUsd * CLASSIFICATION_LIMITS.usdReservationUnits),
                input.reservationId,
              ],
            },
          ]
        : [];
    await this.client.batch(
      [
        {
          sql: `INSERT OR IGNORE INTO classification_decisions
                (candidate_id, question_set_version, rule_version, decision_json, audit_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            input.candidateId,
            input.questionSetVersion,
            input.decision.ruleVersion,
            JSON.stringify(input.decision),
            JSON.stringify(input.audit),
            new Date().toISOString(),
          ],
        },
        { sql: "UPDATE pending_evidence SET status = 'classified' WHERE id = ?", args: [input.candidateId] },
        ...settlement,
      ],
      'write',
    );
  }

  async classification(candidateId: string) {
    const result = await this.client.execute({
      sql: `SELECT question_set_version, rule_version, decision_json, audit_json
            FROM classification_decisions WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [candidateId],
    });
    const row = result.rows[0];
    return row
      ? ({
          questionSetVersion: String(row.question_set_version),
          ruleVersion: String(row.rule_version),
          decision: JSON.parse(String(row.decision_json)) as ClassificationDecision,
          audit: JSON.parse(String(row.audit_json)) as Record<string, unknown>,
        } satisfies StoredClassification)
      : undefined;
  }

  async reservedProviderUsd(provider: 'jev' | 'openai') {
    const result = await this.client.execute({
      sql: 'SELECT COALESCE(SUM(COALESCE(known_amount_units + unresolved_units, amount_units)), 0) AS amount FROM provider_reservations WHERE provider = ?',
      args: [provider],
    });
    return Number(result.rows[0]?.amount ?? 0) / CLASSIFICATION_LIMITS.usdReservationUnits;
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
      sql: `INSERT OR REPLACE INTO source_outcomes (run_id, source_id, status, detail_json)
            SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM monitor_runs WHERE id = ? AND status = 'running')`,
      args: [runId, sourceId, status, JSON.stringify(detail), runId],
    });
  }

  async close() {
    await this.initializing?.catch(() => {});
    this.client.close();
    if (this.localDatabasePath) {
      const entry = localDatabaseOwners.get(this.localDatabasePath);
      entry?.owners.delete(this);
      if (entry?.owners.size === 0) localDatabaseOwners.delete(this.localDatabasePath);
    }
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
