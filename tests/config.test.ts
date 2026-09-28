import { afterEach, describe, expect, it, vi } from 'vitest';

import { INPUT_LIMITS, loadConfig } from '../src/mastra/config';
import { validateMonitorInput } from '../src/mastra/schemas';

afterEach(() => vi.unstubAllEnvs());

describe('execution configuration', () => {
  it('defaults to local loopback without provider credentials', () => {
    expect(loadConfig({})).toMatchObject({
      executionMode: 'local',
      server: { host: '127.0.0.1', apiToken: undefined },
      sources: { maxSources: 20, concurrency: 3, candidatesPerSource: 20 },
      models: {
        jev: 'jev-latest',
        summary: 'openai/gpt-6-luna',
        summaryReasoning: 'none',
        summaryMaxInputTokens: 8_000,
        summaryMaxOutputTokens: 800,
      },
      budgetUsd: { jev: 4.5, openai: 5 },
    });
  });

  it('keeps execution mode independent of NODE_ENV and invocation inputs', () => {
    expect(loadConfig({ NODE_ENV: 'production', runMode: 'scheduled' }).executionMode).toBe('local');
    expect(
      loadConfig({ EXECUTION_MODE: 'local', MASTRA_API_TOKEN: 'synthetic-token' }).server.apiToken,
    ).toBeUndefined();
  });

  it.each(['', ' ', 'staging', 'Production', ' production'])('rejects invalid mode %j', mode => {
    expect(() => loadConfig({ EXECUTION_MODE: mode })).toThrow('EXECUTION_MODE');
  });

  it.each([undefined, '', '  '])('requires a nonblank production token (%j)', token => {
    expect(() => loadConfig({ EXECUTION_MODE: 'production', MASTRA_API_TOKEN: token })).toThrow('MASTRA_API_TOKEN');
  });

  it('returns the exact production token for native auth wiring', () => {
    expect(loadConfig({ EXECUTION_MODE: 'production', MASTRA_API_TOKEN: 'synthetic-token' })).toMatchObject({
      executionMode: 'production',
      server: { host: '0.0.0.0', apiToken: 'synthetic-token' },
    });
  });

  it('rejects token whitespace without disclosing supplied values', () => {
    const token = 'synthetic secret';
    expect(() => loadConfig({ EXECUTION_MODE: 'production', MASTRA_API_TOKEN: token })).toThrow(
      /^Invalid configuration: MASTRA_API_TOKEN$/,
    );
  });

  it('reads the process environment when no explicit environment is supplied', () => {
    for (const key of [
      'MASTRA_API_TOKEN',
      'MAX_SOURCES',
      'CANDIDATES_PER_SOURCE',
      'JEV_BUDGET_USD',
      'OPENAI_BUDGET_USD',
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('EXECUTION_MODE', 'local');
    vi.stubEnv('SOURCE_CONCURRENCY', '2');
    vi.stubEnv('JEV_MODEL', 'test-model-id');
    expect(loadConfig()).toMatchObject({ sources: { concurrency: 2 }, models: { jev: 'test-model-id' } });
  });
});

describe('bounded overrides', () => {
  it('uses the central organization-context bound for workflow input', () => {
    const input = {
      monitorId: 'context-limit',
      profile: {
        name: 'Operator',
        organizationContext: 'x'.repeat(INPUT_LIMITS.maxOrganizationContextChars),
        interests: ['pricing'],
      },
      sources: [{ id: 'pricing', label: 'Pricing', url: 'https://public.example/pricing', kind: 'pricing' }],
    };
    expect(validateMonitorInput(input).profile.organizationContext).toHaveLength(
      INPUT_LIMITS.maxOrganizationContextChars,
    );
    expect(() =>
      validateMonitorInput({
        ...input,
        profile: { ...input.profile, organizationContext: `${input.profile.organizationContext}x` },
      }),
    ).toThrow();
  });

  it('propagates valid overrides without mutating the caller or subsequent defaults', () => {
    const environment = Object.freeze({
      MAX_SOURCES: '10',
      SOURCE_CONCURRENCY: '5',
      CANDIDATES_PER_SOURCE: '50',
      JEV_BUDGET_USD: '1.25',
      OPENAI_BUDGET_USD: '2.5',
      JEV_MODEL: 'test-model-id',
    });
    expect(loadConfig(environment)).toMatchObject({
      sources: { maxSources: 10, concurrency: 5, candidatesPerSource: 50 },
      budgetUsd: { jev: 1.25, openai: 2.5 },
      models: { jev: 'test-model-id' },
    });
    expect(loadConfig({}).sources.concurrency).toBe(3);
  });

  it.each(['MAX_SOURCES', 'SOURCE_CONCURRENCY', 'CANDIDATES_PER_SOURCE'])(
    'requires a positive finite integer for %s',
    key => {
      for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', 'abc', '-1', '0', '1.5']) {
        expect(() => loadConfig({ [key]: value }), `${key}=${JSON.stringify(value)}`).toThrow(key);
      }
      expect(() => loadConfig({ [key]: '1' })).not.toThrow();
    },
  );

  it.each([
    ['MAX_SOURCES', '21'],
    ['SOURCE_CONCURRENCY', '6'],
    ['CANDIDATES_PER_SOURCE', '51'],
    ['JEV_BUDGET_USD', '4.5001'],
    ['OPENAI_BUDGET_USD', '5.0001'],
  ])('rejects %s above its approved ceiling', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  });

  it.each(['JEV_BUDGET_USD', 'OPENAI_BUDGET_USD'])('rejects invalid monetary overrides for %s', key => {
    for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '-0.01', 'abc']) {
      expect(() => loadConfig({ [key]: value }), `${key}=${JSON.stringify(value)}`).toThrow(key);
    }
  });

  it('allows disabling either provider without transferring its budget', () => {
    expect(loadConfig({ JEV_BUDGET_USD: '0' }).budgetUsd).toEqual({ jev: 0, openai: 5 });
    expect(loadConfig({ OPENAI_BUDGET_USD: '0' }).budgetUsd).toEqual({ jev: 4.5, openai: 0 });
  });

  it.each(['', ' '])('rejects a blank Jev model (%j)', value => {
    expect(() => loadConfig({ JEV_MODEL: value })).toThrow('JEV_MODEL');
  });

  it('reports invalid variable names without reflecting their values', () => {
    expect(() => loadConfig({ MAX_SOURCES: 'private-value', OPENAI_BUDGET_USD: 'private-value' })).toThrow(
      /^Invalid configuration: MAX_SOURCES, OPENAI_BUDGET_USD$/,
    );
  });
});
