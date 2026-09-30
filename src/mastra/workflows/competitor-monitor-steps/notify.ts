import { createStep } from '@mastra/core/workflows';

import type { MonitorInput } from '../../schemas';
import { workflowOutputSchema, type MonitorRunResult, type StepContext } from './workflow-context';

/** Final step: fan out changed scheduled runs, then persist the result and release the monitor lock. */
export function createNotifyStep(context: StepContext) {
  const { dependencies } = context;
  return createStep({
    id: 'notify-competitor-changes',
    description: 'Invokes enabled notification providers only for scheduled runs with detected changes.',
    inputSchema: workflowOutputSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData, getInitData }) => {
      const input = getInitData<MonitorInput>();
      const failures: string[] = [];
      if (input.runMode === 'scheduled' && inputData.changes.length > 0) {
        const newIds = new Set(await dependencies.store.candidateIdsForRun(inputData.runId));
        const changes = inputData.changes.filter(change => newIds.has(change.id));
        const event = {
          runId: inputData.runId,
          monitorId: inputData.monitorId,
          monitorName: input.profile.name,
          date: new Date().toISOString(),
          changes,
        };
        for (const provider of changes.length ? (dependencies.notificationProviders ?? []) : []) {
          try {
            await provider.notify(event);
          } catch {
            failures.push(provider.id);
          }
        }
      }
      const result: MonitorRunResult = failures.length
        ? { ...inputData, status: inputData.status === 'failed' ? 'failed' : 'partial', notificationFailures: failures }
        : inputData;
      await dependencies.store.finishRun(
        { id: result.runId, monitorId: result.monitorId, status: 'running', startedAt: '' },
        result.status === 'no_change' ? 'success' : result.status,
        result,
      );
      return result;
    },
  });
}
