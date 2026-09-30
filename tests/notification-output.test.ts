import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { expect, it, vi } from 'vitest';

import { loadConfig } from '../src/mastra/config';
import { dailyMonitorSchedules, scheduledMonitorInputs } from '../src/mastra/config/scheduled-monitors';
import { MonitorStore } from '../src/mastra/lib/store';
import { MarkdownReportProvider } from '../src/mastra/notifications/markdown-report';
import { createCompetitorMonitorWorkflow } from '../src/mastra/workflows/competitor-monitor-workflow';

const input = {
  monitorId: 'example-competitor',
  profile: { name: 'Example competitor', interests: ['pricing'] },
  sources: [{ id: 'pricing', label: 'Pricing', url: 'https://public.example/pricing', kind: 'pricing' }],
};

it('reads only enabled monitor files and creates stable daily declarative schedules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'competitor-schedule-config-'));
  const file = join(directory, 'scheduled-monitors.json');
  try {
    expect(scheduledMonitorInputs({ enabled: false, file }, 3)).toEqual([]);
    expect(() => scheduledMonitorInputs({ enabled: true, file }, 3)).toThrow('Missing scheduled-monitors.json');
    await writeFile(file, JSON.stringify([input]));
    const configured = scheduledMonitorInputs({ enabled: true, file }, 3);
    const schedules = dailyMonitorSchedules(configured);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      cron: '0 9 * * *',
      timezone: 'UTC',
      inputData: { monitorId: input.monitorId, runMode: 'scheduled' },
    });
    expect(dailyMonitorSchedules(configured)[0]?.id).toBe(schedules[0]?.id);
    await writeFile(file, await readFile(new URL('../scheduled-monitors-example.json', import.meta.url), 'utf8'));
    expect(scheduledMonitorInputs({ enabled: true, file }, 3)).toHaveLength(2);
    await writeFile(file, JSON.stringify([input, input]));
    expect(() => scheduledMonitorInputs({ enabled: true, file }, 3)).toThrow('Invalid scheduled-monitors.json');
    await writeFile(file, '[]');
    expect(() => scheduledMonitorInputs({ enabled: true, file }, 3)).toThrow('Invalid scheduled-monitors.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('registers configured daily schedules when Mastra starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'competitor-daily-schedule-'));
  const config = loadConfig({
    MASTRA_DATABASE_URL: `file:${join(directory, 'mastra.db')}`,
    MONITOR_DATABASE_URL: `file:${join(directory, 'monitor.db')}`,
    MASTRA_PROJECT_ROOT: directory,
    ENABLE_MONITOR_SCHEDULER: 'true',
  });
  const store = MonitorStore.open(config.storage.monitorUrl);
  const framework = new LibSQLStore({ id: 'daily-framework', url: config.storage.mastraUrl });
  let mastra: Mastra | undefined;
  try {
    await writeFile(config.schedule.file, JSON.stringify([input]));
    const schedules = dailyMonitorSchedules(scheduledMonitorInputs(config.schedule, config.sources.maxSources));
    const workflow = createCompetitorMonitorWorkflow({ store, config }, schedules);
    mastra = new Mastra({ storage: framework, workflows: { competitorMonitor: workflow } });
    await mastra.startWorkers();
    expect(await mastra.schedules.list({ workflowId: 'competitor-monitor' })).toEqual([
      expect.objectContaining({ cron: '0 9 * * *', timezone: 'UTC', metadata: { monitorId: input.monitorId } }),
    ]);
  } finally {
    await mastra?.stopWorkers();
    await store.close();
    await framework.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('writes one Markdown report for new scheduled changes and fans out to enabled providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'competitor-notifications-'));
  const config = loadConfig({
    MASTRA_DATABASE_URL: `file:${join(directory, 'mastra.db')}`,
    MONITOR_DATABASE_URL: `file:${join(directory, 'monitor.db')}`,
  });
  const store = MonitorStore.open(config.storage.monitorUrl);
  const framework = new LibSQLStore({ id: 'notification-framework', url: config.storage.mastraUrl });
  const reportsDir = join(directory, 'reports');
  const delivered = vi.fn(async () => {});
  let amount = 19;
  const workflow = createCompetitorMonitorWorkflow({
    store,
    config,
    notificationProviders: [
      {
        id: 'broken',
        notify: async () => {
          throw new Error('SIMULATED_FAILURE');
        },
      },
      new MarkdownReportProvider(reportsDir),
      { id: 'second-provider', notify: delivered },
    ],
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async ({ url }: { url: URL }) => ({
      status: 200,
      headers: { 'content-type': url.pathname === '/robots.txt' ? 'text/plain' : 'text/html' },
      body: new TextEncoder().encode(
        url.pathname === '/robots.txt'
          ? 'User-agent: *\nAllow: /'
          : `<main><h1>Pricing</h1><p>Starter costs $${amount} per month. ${'Public pricing information. '.repeat(12)}</p></main>`,
      ),
    }),
  });
  const mastra = new Mastra({ storage: framework, workflows: { competitorMonitor: workflow } });
  const run = async (runMode: 'scheduled' | 'manual') => {
    const execution = await mastra.getWorkflow('competitorMonitor').createRun();
    const started = await execution.start({
      inputData: { ...input, runMode, options: { generateSummary: false } } as any,
    });
    if (started.status !== 'success') throw new Error('WORKFLOW_FAILED');
    return started.result;
  };
  const files = async () =>
    readdir(reportsDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
  try {
    await run('scheduled');
    expect(await files()).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();

    amount = 29;
    const changed = await run('scheduled');
    expect(changed.changes.length).toBeGreaterThan(0);
    expect(changed.notificationFailures).toEqual(['broken']);
    expect(delivered).toHaveBeenCalledTimes(1);
    const reportFiles = await files();
    expect(reportFiles).toHaveLength(1);
    const report = await readFile(join(reportsDir, reportFiles[0]!), 'utf8');
    expect(report).toContain('Date: ');
    expect(report).toContain('Starter costs $19');
    expect(report).toContain('Starter costs $29');

    await run('scheduled');
    expect(await files()).toEqual(reportFiles);
    expect(delivered).toHaveBeenCalledTimes(1);

    amount = 39;
    await run('manual');
    expect(await files()).toEqual(reportFiles);
    expect(delivered).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
    await framework.close();
    await rm(directory, { recursive: true, force: true });
  }
});
