import { isDeepStrictEqual } from 'node:util';

import { SOURCE_LIMITS, TIMING } from '../config';
import { assertRobotsAllowed, fetchPublicPage } from '../lib/acquisition';
import { renderPublicPage } from '../lib/browser';
import {
  contentForCurrentNormalization,
  diffContent,
  normalizeHtml,
  NORMALIZATION_VERSION,
  type NormalizedContent,
} from '../lib/content';
import type { SnapshotAcquisition } from '../lib/store';
import { normalizedSourceUrl, type MonitorInput, type MonitorSource } from '../schemas';
import type { Dependencies, MonitorRunResult } from './competitor-monitor-steps/workflow-context';

/** Marks failures after public content was acquired so run totals do not conflate fetch and processing errors. */
export class CompletedAcquisitionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'UNKNOWN_ERROR');
  }
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

function clientRenderPlaceholder(content: NormalizedContent, minimumContentChars: number) {
  return (
    content.text.length < minimumContentChars &&
    /^(?:[\w -]{1,80}\s+)?(?:loading(?:\.{1,3}|…)?|please wait(?:\.{1,3}|…)?|enable javascript(?:\.{1,3}|…)?)$/i.test(
      content.text.trim(),
    )
  );
}

function shortRenderShell(content: NormalizedContent, html: string, minimumContentChars: number) {
  return (
    content.text.length < minimumContentChars &&
    (content.language === 'english' ||
      (content.language === 'undetermined' && /[a-z]/i.test(content.text) && /<script\b/i.test(html)))
  );
}

function equivalentNormalizationProfile(stored: string, current: string) {
  try {
    const previous = JSON.parse(stored);
    const next = JSON.parse(current);
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return false;
    const { version, ...options } = previous;
    const { version: currentVersion, ...currentOptions } = next;
    return (
      typeof version === 'string' &&
      (version === currentVersion || /^[a-zA-Z][0-9]+-semantic-v2$/.test(version)) &&
      isDeepStrictEqual(options, currentOptions)
    );
  } catch {
    return false;
  }
}

export async function processSource(
  input: MonitorInput,
  runId: string,
  source: MonitorSource,
  dependencies: Dependencies,
  abortSignal?: AbortSignal,
): Promise<{ source: MonitorRunResult['sources'][number] }> {
  let acquisitionCompleted = false;
  try {
    const deadline = AbortSignal.timeout(TIMING.acquisitionDeadlineMs);
    const acquisitionSignal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
    const throwIfCanceled = () => {
      if (abortSignal?.aborted) throw new Error('ACQUISITION_CANCELED');
      if (deadline.aborted) throw new Error('ACQUISITION_TIMEOUT');
    };
    const withinDeadline = async <T>(operation: Promise<T>) => {
      try {
        return await operation;
      } catch (error) {
        if (!abortSignal?.aborted && deadline.aborted) throw new Error('ACQUISITION_TIMEOUT');
        throw error;
      }
    };
    throwIfCanceled();
    const normalizedUrl = normalizedSourceUrl(source.url);
    const storedIdentity = await dependencies.store.sourceIdentity(input.monitorId, source.id);
    throwIfCanceled();
    const profile = JSON.stringify({
      version: NORMALIZATION_VERSION,
      contentSelector: source.contentSelector,
      ignoreSelectors: source.ignoreSelectors,
      minContentChars: source.minContentChars,
    });
    if (
      storedIdentity &&
      (storedIdentity.url !== normalizedUrl || !equivalentNormalizationProfile(storedIdentity.profile, profile))
    ) {
      throw new Error('SOURCE_ID_REBOUND');
    }
    let acquired = await withinDeadline(
      fetchPublicPage(normalizedUrl, {
        ...dependencies,
        abortSignal: acquisitionSignal,
        beforeRequest: url => assertRobotsAllowed(url.href, { ...dependencies, abortSignal: acquisitionSignal }),
      }),
    );
    acquisitionCompleted = true;
    let content: NormalizedContent | undefined;
    const minimumContentChars = source.minContentChars ?? SOURCE_LIMITS.minContentChars;
    let fallbackReason:
      'explicit_browser' | 'short_content' | 'selector_missing' | 'client_render_placeholder' | undefined;
    if (source.fetchMode === 'browser') {
      fallbackReason = 'explicit_browser';
    } else {
      try {
        content = normalizeHtml(acquired.html, source);
      } catch (error) {
        if (source.fetchMode === 'auto' && error instanceof Error && error.message === 'CONTENT_SELECTOR_MISSING') {
          fallbackReason = 'selector_missing';
        } else {
          throw error;
        }
      }
      if (source.fetchMode === 'auto' && !fallbackReason && content && !rejectedPageContent(content, acquired.html)) {
        if (clientRenderPlaceholder(content, minimumContentChars)) {
          fallbackReason = 'client_render_placeholder';
        } else if (shortRenderShell(content, acquired.html, minimumContentChars)) {
          fallbackReason = 'short_content';
        }
      }
    }
    if (fallbackReason) {
      acquired = await withinDeadline(renderPublicPage(acquired, { ...dependencies, abortSignal: acquisitionSignal }));
      content = normalizeHtml(acquired.html, source);
    }
    if (!content) throw new Error('CONTENT_MISSING');
    throwIfCanceled();
    const acquisition: SnapshotAcquisition = {
      mode: fallbackReason ? 'browser' : 'http',
      finalUrl: acquired.url,
      status: acquired.status,
      durationMs: acquired.durationMs,
      retries: acquired.retries,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
    if (rejectedPageContent(content, acquired.html)) throw new Error('BLOCKED_OR_AUTHENTICATED_CONTENT');
    if (content.language === 'unsupported') throw new Error('UNSUPPORTED_LANGUAGE');
    if (content.language === 'undetermined') throw new Error('LANGUAGE_UNDETERMINED');
    const baseline = await dependencies.store.baseline(input.monitorId, source.id);
    throwIfCanceled();
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
          acquisitionCompleted,
          error: { code: 'CONTENT_LOSS_QUARANTINED', retryable: false },
        },
      };
    }
    if (content.truncated) throw new Error('NORMALIZED_CONTENT_LIMIT');
    if (content.text.length < minimumContentChars) throw new Error('CONTENT_QUALITY_TOO_LOW');
    if (content.lossRatio > SOURCE_LIMITS.maxContentLossRatio) throw new Error('CONTENT_QUALITY_LOSS');
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
      return { source: { sourceId: source.id, status: 'baseline_created', acquisitionCompleted } };
    }
    if (input.runMode === 'baseline') {
      throwIfCanceled();
      await dependencies.store.recordSourceOutcome(runId, source.id, 'accepted', {
        code: 'BASELINE_ALREADY_EXISTS',
        snapshotId: baseline.id,
        acquisition,
      });
      return {
        source: { sourceId: source.id, status: 'unchanged', acquisitionCompleted, outcome: 'BASELINE_ALREADY_EXISTS' },
      };
    }
    const baselineContent =
      storedIdentity && JSON.parse(storedIdentity.profile).version !== NORMALIZATION_VERSION
        ? contentForCurrentNormalization(baseline.content)
        : baseline.content;
    if (baselineContent.hash === content.hash) {
      throwIfCanceled();
      const pendingIds = await dependencies.store.pendingIdsForSource(input.monitorId, source.id);
      return {
        source: {
          sourceId: source.id,
          status: pendingIds.length ? 'changed' : 'unchanged',
          acquisitionCompleted,
          warnings: await dependencies.store.pendingWarningsForSource(input.monitorId, source.id),
        },
      };
    }
    const evidence = diffContent(baselineContent, content);
    const candidateLimit = input.policy.maxCandidatesPerSource ?? dependencies.config.sources.candidatesPerSource;
    const warnings = evidence.length > candidateLimit ? ['CANDIDATE_LIMIT'] : [];
    throwIfCanceled();
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
        acquisitionCompleted,
        warnings: await dependencies.store.pendingWarningsForSource(input.monitorId, source.id),
      },
    };
  } catch (error) {
    if (acquisitionCompleted) throw new CompletedAcquisitionError(error);
    throw error;
  }
}
