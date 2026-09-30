import type { Classifier } from '@mastra/core/classifier';
import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import { CLASSIFIER_ID, COMPETITOR_CHANGE_QUESTIONS, sanitizedClassificationError } from '../../lib/classification';
import type { MonitorInput } from '../../schemas';
import { classifyCandidate } from '../candidate-classification';
import {
  classifiedSourcesSchema,
  sourceProcessedSchema,
  type MonitorRunResult,
  type StepContext,
} from './workflow-context';

export function createClassifyPendingStep(context: StepContext) {
  const { dependencies, finishCanceledRun } = context;
  return createStep({
    id: 'classify-pending-competitor-changes',
    description:
      'Resumes bounded pending candidates sequentially through the registered native classifier and persists safe decisions.',
    inputSchema: z.array(sourceProcessedSchema),
    outputSchema: classifiedSourcesSchema,
    execute: async ({ inputData, getInitData, mastra, abortSignal }) => {
      const input = getInitData() as MonitorInput;
      const sourceById = new Map(input.sources.map(source => [source.id, source]));
      const changes: MonitorRunResult['changes'] = [];
      let classifier: Classifier<typeof COMPETITOR_CHANGE_QUESTIONS> | undefined;
      for (const processed of inputData) {
        const stopForCancellation = async () => {
          await finishCanceledRun(processed.runId, processed.monitorId);
          return { processed: inputData, changes };
        };
        if (abortSignal.aborted) return stopForCancellation();
        const source = sourceById.get(processed.sourceId);
        if (!source) continue;
        const candidates = await dependencies.store.pendingCandidatesForSource(input.monitorId, source.id);
        if (processed.source.error?.code === 'SOURCE_ID_REBOUND') {
          changes.push(
            ...candidates.map(candidate => ({
              id: candidate.candidateId,
              sourceId: source.id,
              status: 'deferred' as const,
              reason: 'SOURCE_ID_REBOUND',
            })),
          );
          continue;
        }
        if (input.runMode === 'baseline') {
          changes.push(
            ...candidates.map(candidate => ({
              id: candidate.candidateId,
              sourceId: source.id,
              status: 'deferred' as const,
              reason: 'BASELINE_MODE',
            })),
          );
          continue;
        }
        const maximum = input.policy.maxCandidatesPerSource ?? dependencies.config.sources.candidatesPerSource;
        for (const candidate of candidates.slice(maximum)) {
          changes.push({
            id: candidate.candidateId,
            sourceId: source.id,
            status: 'deferred',
            reason: 'CANDIDATE_LIMIT',
          });
        }
        for (const candidate of candidates.slice(0, maximum)) {
          if (abortSignal.aborted) return stopForCancellation();
          try {
            const outcome = await classifyCandidate({
              candidate,
              source,
              input,
              dependencies,
              getClassifier: () => {
                classifier ??= mastra.getClassifierById(CLASSIFIER_ID) as
                  Classifier<typeof COMPETITOR_CHANGE_QUESTIONS> | undefined;
                return classifier;
              },
              abortSignal,
              runId: processed.runId,
            });
            if (!outcome) return stopForCancellation();
            changes.push(outcome);
          } catch (error) {
            if (abortSignal.aborted) return stopForCancellation();
            const reason =
              error instanceof Error && error.message === 'CANDIDATE_STATE_LIMIT'
                ? 'CANDIDATE_STATE_LIMIT'
                : sanitizedClassificationError(error);
            changes.push({
              id: candidate.candidateId,
              sourceId: source.id,
              status: reason === 'CANDIDATE_STATE_LIMIT' ? 'deferred' : 'failed',
              reason,
            });
          }
        }
      }
      return { processed: inputData, changes };
    },
  });
}
