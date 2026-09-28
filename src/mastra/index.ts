import { Mastra } from '@mastra/core/mastra';
import { SimpleAuth } from '@mastra/core/server';
import { LibSQLStore } from '@mastra/libsql';

import { loadConfig } from './config';
import { ensureDatabaseDirectory, MonitorStore } from './lib/store';
import { createCompetitorMonitorWorkflow } from './workflows/competitor-monitor-workflow';

export function createMastraRuntime(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const config = loadConfig(environment);
  ensureDatabaseDirectory(config.storage.mastraUrl);
  const applicationStore = MonitorStore.open(config.storage.monitorUrl);
  const workflow = createCompetitorMonitorWorkflow({ store: applicationStore, config });
  const frameworkStore = new LibSQLStore({ id: 'competitor-monitor-framework', url: config.storage.mastraUrl });
  const mastra = new Mastra({
    storage: frameworkStore,
    workflows: { competitorMonitor: workflow },
    server:
      config.executionMode === 'production'
        ? {
            host: config.server.host,
            auth: new SimpleAuth({ tokens: { [config.server.apiToken!]: { id: 'operator' } } }),
          }
        : { host: config.server.host },
  });
  return { mastra, applicationStore, frameworkStore };
}

export function createMastra(environment: Readonly<Record<string, string | undefined>> = process.env) {
  return createMastraRuntime(environment).mastra;
}

export const runtime = createMastraRuntime();
export const mastra = runtime.mastra;
