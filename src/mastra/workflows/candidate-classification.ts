import type { Classifier } from '@mastra/core/classifier';

import { CLASSIFICATION_LIMITS, PRICING_REFERENCE, TIMING } from '../config';
import {
  COMPETITOR_CHANGE_QUESTIONS,
  JEV_RESERVATION_USD,
  QUESTION_SET_VERSION,
  classificationAbortSignal,
  classificationState,
  routeClassification,
} from '../lib/classification';
import type { PendingCandidate } from '../lib/store';
import type { MonitorInput, MonitorSource } from '../schemas';
import type { Dependencies } from './competitor-monitor-steps/workflow-context';

function boundedConfidence(value: unknown, question: string) {
  const confidence = value && typeof value === 'object' ? (value as Record<string, unknown>)[question] : undefined;
  return typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : undefined;
}

export async function classifyCandidate({
  candidate,
  source,
  input,
  dependencies,
  getClassifier,
  abortSignal,
}: {
  candidate: PendingCandidate;
  source: MonitorSource;
  input: MonitorInput;
  dependencies: Dependencies;
  getClassifier: () => Classifier<typeof COMPETITOR_CHANGE_QUESTIONS> | undefined;
  abortSignal: AbortSignal;
}) {
  const state = classificationState({
    evidence: candidate,
    source,
    interests: input.profile.interests,
    prioritySignals: input.profile.prioritySignals,
    ignoredSignals: input.profile.ignoredSignals,
    organizationContext: input.profile.organizationContext,
  });
  if (!dependencies.config.credentials.jevApiKey || !dependencies.config.billing.jevCostAttested) {
    return {
      id: candidate.candidateId,
      sourceId: source.id,
      status: 'deferred' as const,
      reason: 'COST_UNVERIFIED',
    };
  }
  const classifier = getClassifier();
  if (!classifier) throw new Error('CLASSIFIER_NOT_REGISTERED');
  const reservation = await dependencies.store.reserveProviderBudget({
    provider: 'jev',
    candidateId: candidate.candidateId,
    amountUsd: JEV_RESERVATION_USD,
    ceilingUsd: dependencies.config.budgetUsd.jev,
  });
  if (!reservation) {
    return {
      id: candidate.candidateId,
      sourceId: source.id,
      status: 'deferred' as const,
      reason: 'BUDGET_EXHAUSTED',
    };
  }
  if (abortSignal.aborted) {
    await dependencies.store.releaseUnattemptedProviderReservation(reservation);
    return undefined;
  }
  const result = await classifier.evaluate({
    state,
    abortSignal: classificationAbortSignal(abortSignal),
    maxRetries: TIMING.maxRetries,
  });
  const decision = routeClassification(candidate, result.answers, result.providerMetadata, input.policy);
  const typesafe =
    result.providerMetadata && typeof result.providerMetadata.typesafe === 'object'
      ? (result.providerMetadata.typesafe as Record<string, unknown>)
      : undefined;
  await dependencies.store.commitClassification({
    candidateId: candidate.candidateId,
    questionSetVersion: QUESTION_SET_VERSION,
    decision,
    audit: {
      answers: result.answers,
      usage: {
        ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
      },
      rounding: result.rounding,
      warnings: result.warnings.map(warning => ({
        type: warning.type,
        ...(warning.type === 'unsupported' ? { feature: warning.feature } : {}),
      })),
      confidence: {
        changeType: boundedConfidence(typesafe?.confidence, 'change_type'),
        relevance: boundedConfidence(typesafe?.confidence, 'relevance'),
        businessImpact: boundedConfidence(typesafe?.confidence, 'business_impact'),
      },
      requestedModel: dependencies.config.models.jev,
      reportedModel: result.response.modelId,
      verifiedModel: undefined,
    },
    ...(result.usage.inputTokens !== undefined &&
    result.usage.outputTokens !== undefined &&
    Number.isFinite(result.usage.inputTokens) &&
    Number.isFinite(result.usage.outputTokens) &&
    result.usage.inputTokens >= 0 &&
    result.usage.outputTokens >= 0 &&
    result.usage.inputTokens <= CLASSIFICATION_LIMITS.jevMaxInputTokens
      ? {
          reservationId: reservation,
          knownUsageUsd:
            (result.usage.inputTokens * PRICING_REFERENCE.jevInputUsdPerMillion) /
            PRICING_REFERENCE.tokensPerPricingUnit,
          unresolvedUsageUsd: (JEV_RESERVATION_USD * TIMING.maxRetries) / (TIMING.maxRetries + 1),
        }
      : {}),
  });
  return {
    id: candidate.candidateId,
    sourceId: source.id,
    status: 'classified' as const,
    route: decision.route,
  };
}
