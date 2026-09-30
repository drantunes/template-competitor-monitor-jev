import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Classifier } from '@mastra/core/classifier';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { LibSQLStore } from '@mastra/libsql';
import { expect, it } from 'vitest';

import { loadConfig } from '../src/mastra/config';
import { CLASSIFIER_ID, COMPETITOR_CHANGE_QUESTIONS } from '../src/mastra/lib/classification';
import { MonitorStore } from '../src/mastra/lib/store';
import { createCompetitorMonitorAgent } from '../src/mastra/monitor-agent';
import { createCompetitorMonitorWorkflow } from '../src/mastra/workflows/competitor-monitor-workflow';
import { EVALUATION_FIXTURES } from './fixtures/evaluation-dataset';

it.each(['generate', 'stream'] as const)(
  'executes the native monitor from chat using %s and preserves comparison history',
  async method => {
    const directory = await mkdtemp(join(tmpdir(), 'competitor-monitor-chat-'));
    const config = loadConfig({
      MONITOR_DATABASE_URL: `file:${join(directory, 'monitor.db')}`,
      MASTRA_DATABASE_URL: `file:${join(directory, 'mastra.db')}`,
      TYPESAFE_AI_API_KEY: 'synthetic',
    });
    const store = MonitorStore.open(config.storage.monitorUrl);
    const framework = new LibSQLStore({ id: 'chat-test', url: config.storage.mastraUrl });
    let price = '$19';
    let classifications = 0;
    const fixture = EVALUATION_FIXTURES.find(item => item.family === 'pricing')!;
    const workflow = createCompetitorMonitorWorkflow({
      store,
      config,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async ({ url }) => ({
        status: 200,
        headers: { 'content-type': url.pathname === '/robots.txt' ? 'text/plain' : 'text/html' },
        body: new TextEncoder().encode(
          url.pathname === '/robots.txt'
            ? 'User-agent: *\nAllow: /'
            : `<main><h1>Pricing</h1><p>Starter costs ${price}.</p><p>${'Public product pricing and documentation details for customers. '.repeat(15)}</p></main>`,
        ),
      }),
    });
    const inputData = {
      monitorId: 'example-product',
      runMode: 'manual',
      profile: { name: 'Example product', interests: ['pricing'] },
      sources: [{ id: 'pricing', label: 'Pricing', url: 'https://public.example/pricing', kind: 'pricing' }],
      options: { generateSummary: false, includeUnchangedSources: true },
    };
    let modelCalls = 0;
    const model = new MastraLanguageModelV2Mock({
      doGenerate: async () => {
        const call = modelCalls++;
        return {
          content:
            call % 2 === 0
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: `monitor-${call}`,
                    toolName: 'workflow-competitorMonitor',
                    input: JSON.stringify({ inputData }),
                  },
                ]
              : [{ type: 'text' as const, text: 'Monitor result received.' }],
          finishReason: call % 2 === 0 ? 'tool-calls' : 'stop',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          warnings: [],
        };
      },
      doStream: async () => {
        const call = modelCalls++;
        const chunks =
          call % 2 === 0
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `monitor-${call}`,
                  toolName: 'workflow-competitorMonitor',
                  input: JSON.stringify({ inputData }),
                },
              ]
            : [
                { type: 'text-start' as const, id: 'reply' },
                { type: 'text-delta' as const, id: 'reply', delta: 'Monitor result received.' },
                { type: 'text-end' as const, id: 'reply' },
              ];
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.enqueue({
                type: 'finish',
                finishReason: call % 2 === 0 ? 'tool-calls' : 'stop',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const agent = createCompetitorMonitorAgent(workflow, model);
    const classifier = new Classifier({
      id: CLASSIFIER_ID,
      questions: COMPETITOR_CHANGE_QUESTIONS,
      model: {
        specificationVersion: 'v4',
        provider: 'fixture',
        modelId: 'fixture',
        supportedQuestionTypes: ['choice', 'score', 'boolean'],
        doEvaluate: async () => {
          classifications++;
          return {
            answers: {
              ...fixture.answers!,
              change_type: {
                ...fixture.answers!.change_type,
                probabilities: Object.fromEntries(
                  Object.keys(COMPETITOR_CHANGE_QUESTIONS.change_type.criteria).map(choice => [
                    choice,
                    choice === 'pricing' ? 1 : 0,
                  ]),
                ),
              },
            },
            usage: {},
            warnings: [],
            rounding: {},
            providerMetadata: fixture.providerMetadata,
            response: { modelId: 'fixture', timestamp: new Date() },
          };
        },
      } as any,
    });
    const mastra = new Mastra({
      agents: { competitorMonitor: agent },
      workflows: { competitorMonitor: workflow },
      classifiers: { competitorChange: classifier },
      storage: framework,
    });
    async function check() {
      const activeAgent = mastra.getAgent('competitorMonitor');
      const result =
        method === 'generate'
          ? await activeAgent.generate('Check Example product pricing at https://public.example/pricing.')
          : await activeAgent.stream('Check Example product pricing at https://public.example/pricing.');
      if (method === 'stream') await (result as Awaited<ReturnType<typeof activeAgent.stream>>).consumeStream();
      expect(await result.text).toBe('Monitor result received.');
      const steps = await result.steps;
      const toolResult = steps
        .flatMap(step => step.toolResults)
        .find(item => item.payload.toolName === 'workflow-competitorMonitor');
      expect(toolResult).toBeDefined();
      return (
        toolResult!.payload.result as {
          result: {
            status: string;
            counts: { candidatesClassified: number };
            changes: Array<{ evidence?: { beforeExcerpt: string; afterExcerpt: string } }>;
          };
        }
      ).result;
    }
    try {
      const baseline = await check();
      expect(baseline.status).toBe('success');
      expect(classifications).toBe(0);
      price = '$29';
      const changed = await check();
      expect(changed.counts.candidatesClassified).toBe(1);
      expect(changed.changes[0]?.evidence).toMatchObject({
        beforeExcerpt: 'Starter costs $19.',
        afterExcerpt: 'Starter costs $29.',
      });
      expect(classifications).toBe(1);
      const unchanged = await check();
      expect(unchanged.status).toBe('no_change');
      expect(classifications).toBe(1);
      expect((await store.client.execute('SELECT * FROM classification_decisions')).rows).toHaveLength(1);
    } finally {
      await store.close();
      await framework.close();
    }
  },
);
