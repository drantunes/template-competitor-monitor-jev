import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { SOURCE_LIMITS, type MonitorConfig } from '../config';
import { assertRobotsAllowed, fetchPublicPage, type DnsResolver, type PinnedTransport } from '../lib/acquisition';
import {
  diffContent,
  normalizeHtml,
  NORMALIZATION_VERSION,
  type Evidence,
  type NormalizedContent,
} from '../lib/content';
import { MonitorStore } from '../lib/store';
import {
  monitorInputSchema,
  normalizedSourceUrl,
  validateMonitorInput,
  type MonitorInput,
  type MonitorSource,
} from '../schemas';

export type MonitorRunResult = {
  runId: string;
  monitorId: string;
  status: 'success' | 'partial' | 'no_change' | 'failed';
  counts: {
    sourcesRequested: number;
    sourcesChecked: number;
    sourcesFailed: number;
    candidatesDetected: number;
    candidatesDeferred: number;
  };
  sources: Array<{
    sourceId: string;
    status: 'baseline_created' | 'unchanged' | 'changed' | 'failed';
    error?: { code: string; retryable: boolean };
    outcome?: string;
    warnings?: string[];
  }>;
  changes: Array<{ id: string; sourceId: string; status: 'pending' }>;
};

type Dependencies = { store: MonitorStore; config: MonitorConfig; resolver?: DnsResolver; transport?: PinnedTransport };

class RunConcurrencyLimiter {
  private readonly runs = new Map<string, { active: number; waiters: Array<() => void> }>();

  async run<T>(runId: string, limit: number, task: () => Promise<T>) {
    const state = this.runs.get(runId) ?? { active: 0, waiters: [] };
    this.runs.set(runId, state);
    if (state.active >= limit) await new Promise<void>(resolve => state.waiters.push(resolve));
    state.active += 1;
    try {
      return await task();
    } finally {
      state.active -= 1;
      state.waiters.shift()?.();
      if (state.active === 0 && state.waiters.length === 0) this.runs.delete(runId);
    }
  }
}

function errorDetails(error: unknown) {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  return { code: message, retryable: /TIMEOUT|HTTP_429|HTTP_5\d\d|DNS_TIMEOUT/.test(message) };
}

function rejectedPageContent(content: NormalizedContent, html: string) {
  const primary = [content.title, content.primaryHeading].filter(Boolean).join(' ');
  const hasPasswordForm = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html);
  const login = /\b(sign[ -]?in|log[ -]?in)\b/i.test(primary);
  const challenge =
    /\b(access denied|verify you are human|captcha|enable cookies|unusual traffic|request blocked)\b/i.test(primary);
  const serviceFailure = /\b(service unavailable|technical difficulties|temporarily unavailable)\b/i.test(primary);
  const corroboratingFailure =
    /\b(error(?:\s+code)?|request id|try again|blocked|challenge|captcha|technical difficult|temporar)/i.test(
      content.text,
    );
  return (login && hasPasswordForm) || ((challenge || serviceFailure) && corroboratingFailure);
}

async function processSource(
  input: MonitorInput,
  runId: string,
  source: MonitorSource,
  dependencies: Dependencies,
): Promise<{ source: MonitorRunResult['sources'][number]; evidence: Evidence[]; pendingIds: string[] }> {
  const normalizedUrl = normalizedSourceUrl(source.url);
  const storedIdentity = await dependencies.store.sourceIdentity(input.monitorId, source.id);
  const profile = JSON.stringify({
    version: NORMALIZATION_VERSION,
    contentSelector: source.contentSelector,
    ignoreSelectors: source.ignoreSelectors,
  });
  if (storedIdentity && (storedIdentity.url !== normalizedUrl || storedIdentity.profile !== profile)) {
    throw new Error('SOURCE_ID_REBOUND');
  }
  if (source.fetchMode === 'browser') throw new Error('BROWSER_UNAVAILABLE_F1');
  await assertRobotsAllowed(normalizedUrl, dependencies);
  const acquired = await fetchPublicPage(normalizedUrl, dependencies);
  const acquisition = {
    mode: 'http' as const,
    finalUrl: acquired.url,
    status: acquired.status,
    durationMs: acquired.durationMs,
    retries: acquired.retries,
  };
  const content = normalizeHtml(acquired.html, source);
  if (rejectedPageContent(content, acquired.html)) throw new Error('BLOCKED_OR_AUTHENTICATED_CONTENT');
  if (content.language === 'unsupported') throw new Error('UNSUPPORTED_LANGUAGE');
  if (content.language === 'undetermined') throw new Error('LANGUAGE_UNDETERMINED');
  if (content.truncated) throw new Error('NORMALIZED_CONTENT_LIMIT');
  if (content.text.length < SOURCE_LIMITS.minContentChars) throw new Error('CONTENT_QUALITY_TOO_LOW');
  if (content.lossRatio > SOURCE_LIMITS.maxContentLossRatio) throw new Error('CONTENT_QUALITY_LOSS');
  const baseline = await dependencies.store.baseline(input.monitorId, source.id);
  if (
    baseline &&
    content.text.length / Math.max(1, baseline.content.text.length) < 1 - SOURCE_LIMITS.maxContentLossRatio
  ) {
    await dependencies.store.persistQuarantinedSnapshot({
      runId,
      monitorId: input.monitorId,
      sourceId: source.id,
      sourceUrl: normalizedUrl,
      content,
      acquisition,
      code: 'CONTENT_LOSS_QUARANTINED',
      reason: {
        acceptedContentChars: baseline.content.text.length,
        retrievedContentChars: content.text.length,
        lossRatio: 1 - content.text.length / Math.max(1, baseline.content.text.length),
      },
    });
    return {
      source: {
        sourceId: source.id,
        status: 'failed',
        error: { code: 'CONTENT_LOSS_QUARANTINED', retryable: false },
      },
      evidence: [],
      pendingIds: [],
    };
  }
  if (!baseline) {
    await dependencies.store.persistAcceptedSnapshot({
      runId,
      monitorId: input.monitorId,
      sourceId: source.id,
      sourceUrl: normalizedUrl,
      normalizationProfile: profile,
      content,
      acquisition,
      evidence: [],
      promoteBaseline: true,
    });
    return { source: { sourceId: source.id, status: 'baseline_created' }, evidence: [], pendingIds: [] };
  }
  if (input.runMode === 'baseline') {
    await dependencies.store.recordSourceOutcome(runId, source.id, 'accepted', {
      code: 'BASELINE_ALREADY_EXISTS',
      snapshotId: baseline.id,
      acquisition,
    });
    return {
      source: { sourceId: source.id, status: 'unchanged', outcome: 'BASELINE_ALREADY_EXISTS' },
      evidence: [],
      pendingIds: [],
    };
  }
  if (baseline.content.hash === content.hash) {
    const pendingIds = await dependencies.store.pendingIdsForSource(input.monitorId, source.id);
    return {
      source: {
        sourceId: source.id,
        status: pendingIds.length ? 'changed' : 'unchanged',
        warnings: await dependencies.store.pendingWarningsForSource(input.monitorId, source.id),
      },
      evidence: [],
      pendingIds,
    };
  }
  const evidence = diffContent(baseline.content, content);
  const candidateLimit = input.policy.maxCandidatesPerSource ?? dependencies.config.sources.candidatesPerSource;
  const warnings = evidence.length > candidateLimit ? ['CANDIDATE_LIMIT'] : [];
  await dependencies.store.persistAcceptedSnapshot({
    runId,
    monitorId: input.monitorId,
    sourceId: source.id,
    sourceUrl: normalizedUrl,
    normalizationProfile: profile,
    content,
    acquisition,
    beforeSnapshot: baseline,
    evidence,
    promoteBaseline: true,
    warnings,
  });
  return {
    source: {
      sourceId: source.id,
      status: 'changed',
      warnings: await dependencies.store.pendingWarningsForSource(input.monitorId, source.id),
    },
    evidence,
    pendingIds: await dependencies.store.pendingIdsForSource(input.monitorId, source.id),
  };
}

export async function runCompetitorMonitor(value: unknown, dependencies: Dependencies): Promise<MonitorRunResult> {
  const input = validateMonitorInput(value);
  const config = dependencies.config;
  if (input.sources.length > config.sources.maxSources) throw new Error('SOURCE_LIMIT_EXCEEDED');
  if ((input.policy.sourceConcurrency ?? config.sources.concurrency) > config.sources.concurrency) {
    throw new Error('EFFECTIVE_CONCURRENCY_EXCEEDED');
  }
  if (
    (input.policy.maxCandidatesPerSource ?? config.sources.candidatesPerSource) > config.sources.candidatesPerSource
  ) {
    throw new Error('EFFECTIVE_CANDIDATE_LIMIT_EXCEEDED');
  }
  const run = await dependencies.store.beginRun(input.monitorId);
  try {
    const limiter = new RunConcurrencyLimiter();
    const processed: Array<{
      source: MonitorRunResult['sources'][number];
      evidence: Evidence[];
      pendingIds: string[];
    }> = [];
    const processOne = async (source: MonitorSource) => {
      try {
        return await limiter.run(run.id, input.policy.sourceConcurrency ?? config.sources.concurrency, () =>
          processSource(input, run.id, source, dependencies),
        );
      } catch (error) {
        await dependencies.store.recordSourceOutcome(
          run.id,
          source.id,
          /QUARANTINED|QUALITY|LANGUAGE/.test(errorDetails(error).code) ? 'quarantined' : 'failed',
          errorDetails(error),
        );
        return {
          source: { sourceId: source.id, status: 'failed' as const, error: errorDetails(error) },
          evidence: [],
          pendingIds: [],
        };
      }
    };
    processed.push(...(await Promise.all(input.sources.map(processOne))));
    const sources = processed.map(item => item.source);
    const pendingIds = processed.flatMap(item => item.pendingIds);
    const checked = sources.filter(source => source.status !== 'failed').length;
    const failed = sources.filter(source => source.status === 'failed').length;
    const baselineCreated = sources.filter(source => source.status === 'baseline_created').length;
    const status =
      failed === sources.length
        ? 'failed'
        : failed > 0 || pendingIds.length > 0
          ? 'partial'
          : baselineCreated > 0
            ? 'success'
            : checked === sources.length
              ? 'no_change'
              : 'success';
    const result: MonitorRunResult = {
      runId: run.id,
      monitorId: input.monitorId,
      status,
      counts: {
        sourcesRequested: sources.length,
        sourcesChecked: checked,
        sourcesFailed: failed,
        candidatesDetected: pendingIds.length,
        candidatesDeferred: pendingIds.length,
      },
      sources,
      changes: pendingIds.map(id => ({
        id,
        sourceId: processed.find(item => item.pendingIds.includes(id))?.source.sourceId ?? '',
        status: 'pending',
      })),
    };
    await dependencies.store.finishRun(run, status === 'no_change' ? 'success' : status, result);
    return result;
  } catch (error) {
    await dependencies.store.finishRun(run, 'failed', { code: errorDetails(error).code });
    throw error;
  }
}

const workflowOutputSchema = z.object({
  runId: z.string(),
  monitorId: z.string(),
  status: z.enum(['success', 'partial', 'no_change', 'failed']),
  counts: z.object({
    sourcesRequested: z.number().int(),
    sourcesChecked: z.number().int(),
    sourcesFailed: z.number().int(),
    candidatesDetected: z.number().int(),
    candidatesDeferred: z.number().int(),
  }),
  sources: z.array(
    z.object({
      sourceId: z.string(),
      status: z.string(),
      error: z.object({ code: z.string(), retryable: z.boolean() }).optional(),
      outcome: z.string().optional(),
      warnings: z.array(z.string()).optional(),
    }),
  ),
  changes: z.array(z.object({ id: z.string(), sourceId: z.string(), status: z.literal('pending') })),
});

const sourceTaskSchema = z.object({ runId: z.string(), input: monitorInputSchema, source: z.any() });
const sourceProcessedSchema = z.object({
  runId: z.string(),
  monitorId: z.string(),
  sourceId: z.string(),
  source: z.any(),
  pendingIds: z.array(z.string()),
});

function validateEffectiveLimits(input: MonitorInput, config: MonitorConfig) {
  if (input.sources.length > config.sources.maxSources) throw new Error('SOURCE_LIMIT_EXCEEDED');
  if ((input.policy.sourceConcurrency ?? config.sources.concurrency) > config.sources.concurrency) {
    throw new Error('EFFECTIVE_CONCURRENCY_EXCEEDED');
  }
  if (
    (input.policy.maxCandidatesPerSource ?? config.sources.candidatesPerSource) > config.sources.candidatesPerSource
  ) {
    throw new Error('EFFECTIVE_CANDIDATE_LIMIT_EXCEEDED');
  }
}

export function createCompetitorMonitorWorkflow(dependencies: Dependencies) {
  const sourceLimiter = new RunConcurrencyLimiter();
  const prepare = createStep({
    id: 'prepare-competitor-sources',
    description:
      'Validates a monitor invocation, obtains its same-monitor lock, and prepares bounded source work items.',
    inputSchema: monitorInputSchema,
    outputSchema: z.array(sourceTaskSchema),
    execute: async ({ inputData }) => {
      const input = validateMonitorInput(inputData);
      validateEffectiveLimits(input, dependencies.config);
      const run = await dependencies.store.beginRun(input.monitorId);
      return input.sources.map(source => ({ runId: run.id, input, source }));
    },
  });
  const collectOne = createStep({
    id: 'collect-one-competitor-source',
    description: 'Collects one validated public source and atomically persists its snapshot, evidence, and outcome.',
    inputSchema: sourceTaskSchema,
    outputSchema: sourceProcessedSchema,
    execute: async ({ inputData }) => {
      try {
        const processed = await sourceLimiter.run(
          inputData.runId,
          inputData.input.policy.sourceConcurrency ?? dependencies.config.sources.concurrency,
          () => processSource(inputData.input, inputData.runId, inputData.source, dependencies),
        );
        return {
          ...processed,
          runId: inputData.runId,
          monitorId: inputData.input.monitorId,
          sourceId: inputData.source.id,
        };
      } catch (error) {
        const detail = errorDetails(error);
        await dependencies.store.recordSourceOutcome(
          inputData.runId,
          inputData.source.id,
          /QUARANTINED|QUALITY|LANGUAGE/.test(detail.code) ? 'quarantined' : 'failed',
          detail,
        );
        return {
          runId: inputData.runId,
          monitorId: inputData.input.monitorId,
          sourceId: inputData.source.id,
          source: { sourceId: inputData.source.id, status: 'failed', error: detail },
          pendingIds: [],
        };
      }
    },
  });
  const finalize = createStep({
    id: 'finalize-competitor-run',
    description: 'Aggregates source statuses and releases the same-monitor lock after durable run completion.',
    inputSchema: z.array(sourceProcessedSchema),
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => {
      const processed = inputData;
      const sources = processed.map(item => item.source) as MonitorRunResult['sources'];
      const pendingIds = processed.flatMap(item => item.pendingIds);
      const failed = sources.filter(source => source.status === 'failed').length;
      const checked = sources.length - failed;
      const baselineCreated = sources.filter(source => source.status === 'baseline_created').length;
      const status =
        failed === sources.length
          ? 'failed'
          : failed > 0 || pendingIds.length > 0
            ? 'partial'
            : baselineCreated > 0
              ? 'success'
              : 'no_change';
      const first = processed[0]!;
      const result: MonitorRunResult = {
        runId: first.runId,
        monitorId: first.monitorId,
        status,
        counts: {
          sourcesRequested: sources.length,
          sourcesChecked: checked,
          sourcesFailed: failed,
          candidatesDetected: pendingIds.length,
          candidatesDeferred: pendingIds.length,
        },
        sources,
        changes: pendingIds.map(id => ({
          id,
          sourceId: processed.find(processedSource => processedSource.pendingIds.includes(id))?.sourceId ?? '',
          status: 'pending',
        })),
      };
      await dependencies.store.finishRun(
        { id: first.runId, monitorId: first.monitorId, status: 'running', startedAt: '' },
        status === 'no_change' ? 'success' : status,
        result,
      );
      return result;
    },
  });
  return createWorkflow({
    id: 'competitor-monitor',
    description:
      'Safely collects configured public competitor sources and persists immutable evidence for later review.',
    inputSchema: monitorInputSchema,
    outputSchema: workflowOutputSchema,
  })
    .then(prepare)
    .foreach(collectOne, { concurrency: dependencies.config.sources.concurrency })
    .then(finalize)
    .commit();
}
