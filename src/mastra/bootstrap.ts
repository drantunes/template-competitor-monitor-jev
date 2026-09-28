import { SimpleAuth } from '@mastra/core/server';
import { LibSQLStore } from '@mastra/libsql';

import { loadConfig } from './config';
import { createLocalObservability } from './lib/observability';
import { ensureDatabaseDirectory, MonitorStore } from './lib/store';
import { createCompetitorMonitorWorkflow } from './workflows/competitor-monitor-workflow';

/** Initialize one runtime's configuration and local dependencies without making provider calls. */
export function initializeRuntime(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const config = loadConfig(environment);
  ensureDatabaseDirectory(config.storage.mastraUrl);
  const applicationStore = MonitorStore.open(config.storage.monitorUrl);
  const workflow = createCompetitorMonitorWorkflow({ store: applicationStore, config });
  const frameworkStore = new LibSQLStore({ id: 'competitor-monitor-framework', url: config.storage.mastraUrl });
  return {
    config,
    applicationStore,
    frameworkStore,
    workflow,
    observability: createLocalObservability(),
    server:
      config.executionMode === 'production'
        ? {
            host: config.server.host,
            auth: new SimpleAuth({ tokens: { [config.server.apiToken!]: { id: 'operator' } } }),
          }
        : { host: config.server.host },
  };
}

export const bootstrap = initializeRuntime();
