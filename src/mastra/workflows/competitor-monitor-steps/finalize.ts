import { createStep } from '@mastra/core/workflows';

import {
  classifiedSourcesSchema,
  workflowOutputSchema,
  type MonitorRunResult,
  type StepContext,
} from './workflow-context';

export function createFinalizeStep(context: StepContext) {
  const { dependencies } = context;
  return createStep({
    id: 'finalize-competitor-run',
    description: 'Aggregates source statuses and releases the same-monitor lock after durable run completion.',
    inputSchema: classifiedSourcesSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => {
      const processed = inputData.processed;
      const sources = processed.map(item => item.source);
      const pendingIds = inputData.changes.filter(change => change.status !== 'classified').map(change => change.id);
      const failed = sources.filter(source => source.status === 'failed').length;
      const checked = sources.length - failed;
      const baselineCreated = sources.filter(source => source.status === 'baseline_created').length;
      const status =
        failed === sources.length
          ? 'failed'
          : failed > 0 || pendingIds.length > 0
            ? 'partial'
            : baselineCreated > 0 || inputData.changes.some(change => change.status === 'classified')
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
          candidatesDetected: inputData.changes.length,
          candidatesClassified: inputData.changes.filter(change => change.status === 'classified').length,
          candidatesDeferred: pendingIds.length,
        },
        sources,
        changes: inputData.changes,
      };
      await dependencies.store.finishRun(
        { id: first.runId, monitorId: first.monitorId, status: 'running', startedAt: '' },
        status === 'no_change' ? 'success' : status,
        result,
      );
      return result;
    },
  });
}
