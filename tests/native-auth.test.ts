import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHonoServer } from '@mastra/deployer/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/mastra/config';
import { normalizeHtml } from '../src/mastra/lib/content';

type Runtime = ReturnType<typeof import('../src/mastra/index').createMastraRuntime>;
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).flatMap(runtime => [runtime.applicationStore.close(), runtime.frameworkStore.close()]),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function productionApp(token: string) {
  const directory = await mkdtemp(join(tmpdir(), 'competitor-monitor-auth-'));
  // The module exports a default server instance, so isolate its import-time databases first.
  vi.stubEnv('MASTRA_DATABASE_URL', `file:${join(directory, 'import-mastra.db')}`);
  vi.stubEnv('MONITOR_DATABASE_URL', `file:${join(directory, 'import-monitor.db')}`);
  vi.stubEnv('EXECUTION_MODE', 'local');
  const { createMastraRuntime, runtime: importedRuntime } = await import('../src/mastra/index');
  if (!runtimes.includes(importedRuntime)) runtimes.push(importedRuntime);
  const runtime = createMastraRuntime({
    EXECUTION_MODE: 'production',
    MASTRA_API_TOKEN: token,
    MASTRA_DATABASE_URL: `file:${join(directory, 'mastra.db')}`,
    MONITOR_DATABASE_URL: `file:${join(directory, 'monitor.db')}`,
  });
  runtimes.push(runtime);
  return createHonoServer(runtime.mastra);
}

describe('native Mastra SimpleAuth', () => {
  it('reuses durable databases from native dev through build cleanup and native start', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'competitor-monitor-start-'));
    const nativeDevRoot = join(projectRoot, '.mastra');
    const outputDirectory = join(nativeDevRoot, 'output');
    const packagesFile = join(nativeDevRoot, 'mastra-packages.json');
    await mkdir(outputDirectory, { recursive: true });
    vi.stubEnv('EXECUTION_MODE', 'local');
    // Mastra CLI 1.31.3's dev launcher sets these values while running from `.mastra/output`.
    vi.stubEnv('MASTRA_PROJECT_ROOT', nativeDevRoot);
    vi.stubEnv('MASTRA_DEV', 'true');
    vi.stubEnv('MASTRA_PACKAGES_FILE', packagesFile);
    vi.stubEnv('MASTRA_DATABASE_URL', undefined);
    vi.stubEnv('MONITOR_DATABASE_URL', undefined);
    const currentDirectory = vi.spyOn(process, 'cwd').mockReturnValue(outputDirectory);
    const { createMastraRuntime, runtime: first } = await import('../src/mastra/index');
    runtimes.push(first);
    await first.frameworkStore.init();
    const run = await first.applicationStore.beginRun('durable-monitor');
    const snapshot = await first.applicationStore.persistAcceptedSnapshot({
      runId: run.id,
      monitorId: 'durable-monitor',
      sourceId: 'pricing',
      sourceUrl: 'https://public.example/pricing',
      normalizationProfile: 'test-profile',
      content: normalizeHtml('<main><h1>Pricing</h1><p>Starter plan $19 per month.</p></main>'),
      evidence: [],
      promoteBaseline: true,
    });
    await first.applicationStore.finishRun(run, 'success', { snapshotId: snapshot.id });
    const devPaths = loadConfig({
      MASTRA_PROJECT_ROOT: nativeDevRoot,
      MASTRA_DEV: 'true',
      MASTRA_PACKAGES_FILE: packagesFile,
    }).storage;
    expect(devPaths.mastraUrl).toContain(`${projectRoot}/.data/mastra.db`);
    expect(devPaths.monitorUrl).toContain(`${projectRoot}/.data/competitor-monitor.db`);
    // A direct explicit `.mastra` root remains literal unless the native dev marker is present.
    expect(loadConfig({ MASTRA_PROJECT_ROOT: nativeDevRoot }).storage.monitorUrl).toContain(
      `${nativeDevRoot}/.data/competitor-monitor.db`,
    );
    await first.applicationStore.close();
    await first.frameworkStore.close();
    runtimes.splice(runtimes.indexOf(first), 1);
    // Native build preparation wipes only this temporary project's build area.
    await rm(nativeDevRoot, { recursive: true });
    currentDirectory.mockReturnValue(projectRoot);
    vi.stubEnv('MASTRA_DEV', undefined);
    vi.stubEnv('MASTRA_PACKAGES_FILE', undefined);
    vi.stubEnv('MASTRA_PROJECT_ROOT', projectRoot);
    const startPaths = loadConfig({ MASTRA_PROJECT_ROOT: projectRoot }).storage;
    expect(startPaths).toEqual(devPaths);
    expect(loadConfig({}).storage).toEqual(startPaths);
    const reopened = createMastraRuntime({});
    runtimes.push(reopened);
    await reopened.frameworkStore.init();
    expect((await reopened.applicationStore.baseline('durable-monitor', 'pricing'))?.id).toBe(snapshot.id);
    await access(join(projectRoot, '.data', 'mastra.db'));
    await access(join(projectRoot, '.data', 'competitor-monitor.db'));
    const custom = loadConfig({ MASTRA_PROJECT_ROOT: projectRoot, MONITOR_DATABASE_URL: 'file:./custom/history.db' });
    const overridden = createMastraRuntime({
      MASTRA_PROJECT_ROOT: projectRoot,
      MONITOR_DATABASE_URL: 'file:./custom/history.db',
    });
    runtimes.push(overridden);
    expect(custom.storage.monitorUrl).toContain('/custom/history.db');
    await overridden.applicationStore.init();
    await access(join(projectRoot, 'custom', 'history.db'));
  });

  it('production_auth_rejects_missing_invalid_tokens', async () => {
    const app = await productionApp('current-token');
    const protectedReads = ['/api/workflows', '/api/workflows/competitorMonitor/runs', '/api/schedules'];
    for (const path of protectedReads) {
      expect((await app.request(path)).status, path).toBe(401);
      expect((await app.request(path, { headers: { Authorization: 'Bearer invalid-token' } })).status, path).toBe(401);
      expect((await app.request(path, { headers: { Authorization: 'Bearer current-token' } })).status, path).toBe(200);
    }
    const startPath = '/api/workflows/competitorMonitor/start';
    const start = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    expect((await app.request(startPath, start)).status).toBe(401);
    expect(
      (
        await app.request(startPath, {
          ...start,
          headers: { ...start.headers, Authorization: 'Bearer invalid-token' },
        })
      ).status,
    ).toBe(401);
    // A syntactically invalid payload reaches the registered handler under the current token,
    // proving this is an auth assertion rather than a 404/500 route accident.
    expect(
      (
        await app.request(startPath, {
          ...start,
          headers: { ...start.headers, Authorization: 'Bearer current-token' },
        })
      ).status,
    ).toBe(400);
  });

  it('execution_mode_defaults_local_and_token_rotation', async () => {
    expect(loadConfig({}).executionMode).toBe('local');
    expect(() => loadConfig({ EXECUTION_MODE: 'production' })).toThrow('MASTRA_API_TOKEN');
    const oldApp = await productionApp('old-token');
    expect((await oldApp.request('/api/workflows', { headers: { Authorization: 'Bearer old-token' } })).status).toBe(
      200,
    );
    const rotatedApp = await productionApp('new-token');
    expect(
      (await rotatedApp.request('/api/workflows', { headers: { Authorization: 'Bearer old-token' } })).status,
    ).toBe(401);
    expect(
      (await rotatedApp.request('/api/workflows', { headers: { Authorization: 'Bearer new-token' } })).status,
    ).toBe(200);
  });
});
