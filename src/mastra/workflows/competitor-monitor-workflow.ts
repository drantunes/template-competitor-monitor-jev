import { createWorkflow } from '@mastra/core/workflows';

import { monitorInputSchema, type MonitorInput } from '../schemas';
import { createPrepareStep } from './competitor-monitor-steps/prepare';
import { createCollectOneStep } from './competitor-monitor-steps/collect-one';
import { createClassifyPendingStep } from './competitor-monitor-steps/classify-pending';
import { createFinalizeStep } from './competitor-monitor-steps/finalize';
import { createNotifyStep } from './competitor-monitor-steps/notify';
import {
  createStepContext,
  workflowOutputSchema,
  type Dependencies,
} from './competitor-monitor-steps/workflow-context';

export function createCompetitorMonitorWorkflow(
  dependencies: Dependencies,
  schedules: Array<{
    id: string;
    cron: string;
    timezone: string;
    inputData: MonitorInput;
    metadata: { monitorId: string };
  }> = [],
) {
  const context = createStepContext(dependencies);
  return createWorkflow({
    id: 'competitor-monitor',
    description:
      'Safely collects configured public competitor sources and persists immutable evidence for later review.',
    inputSchema: monitorInputSchema,
    outputSchema: workflowOutputSchema,
    ...(schedules.length ? { schedule: schedules } : {}),
  })
    .then(createPrepareStep(context))
    .foreach(createCollectOneStep(context), { concurrency: dependencies.config.sources.concurrency })
    .then(createClassifyPendingStep(context))
    .then(createFinalizeStep(context))
    .then(createNotifyStep(context))
    .commit();
}
