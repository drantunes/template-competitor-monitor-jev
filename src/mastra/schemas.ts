import { z } from 'zod';

import { INPUT_LIMITS, POLICY_DEFAULTS, RUBRIC, SOURCE_LIMITS } from './config';

// Shared identifier boundary for persisted monitor and source identities.
const identifier = z.string().trim().min(1).max(INPUT_LIMITS.maxIdentifierChars);

// Public source configuration and URL normalization used by acquisition and deduplication.
export const sourceKindSchema = z.enum(['pricing', 'changelog', 'documentation', 'blog', 'status', 'other']);
export const fetchModeSchema = z.enum(['auto', 'http', 'browser']);

export const sourceSchema = z
  .object({
    id: identifier,
    label: z.string().trim().min(1).max(INPUT_LIMITS.maxLabelChars),
    url: z.string().url().max(INPUT_LIMITS.maxUrlChars),
    kind: sourceKindSchema,
    fetchMode: fetchModeSchema.default('auto'),
    contentSelector: z.string().trim().min(1).max(INPUT_LIMITS.maxSelectorChars).optional(),
    ignoreSelectors: z
      .array(z.string().trim().min(1).max(INPUT_LIMITS.maxSelectorChars))
      .max(INPUT_LIMITS.maxSelectors)
      .default([]),
  })
  .strict();

export type MonitorSource = z.infer<typeof sourceSchema>;

export function normalizedSourceUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('UNSAFE_URL_SCHEME');
  if (url.username || url.password) throw new Error('UNSAFE_URL_CREDENTIALS');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))
    url.port = '';
  return url.toString();
}

// Monitor profile, routing policy, and run options supplied by an operator.
export const interestSchema = z.enum([
  'pricing',
  'packaging',
  'product_feature',
  'availability',
  'deprecation',
  'policy_terms',
  'security_compliance',
  'documentation',
  'company_announcement',
]);

export const runModeSchema = z.enum(['baseline', 'manual', 'scheduled']).default('manual');

const boundedProbability = z.number().finite().min(RUBRIC.minProbability).max(RUBRIC.maxProbability);
const boundedScore = z.number().finite().min(RUBRIC.minScore).max(RUBRIC.maxScore);

export const monitorInputSchema = z
  .object({
    monitorId: identifier,
    runMode: runModeSchema,
    profile: z
      .object({
        name: z.string().trim().min(1).max(INPUT_LIMITS.maxLabelChars),
        organizationContext: z.string().trim().max(INPUT_LIMITS.maxOrganizationContextChars).optional(),
        interests: z.array(interestSchema).min(1).max(INPUT_LIMITS.maxInterests),
        prioritySignals: z
          .array(z.string().trim().min(1).max(INPUT_LIMITS.maxSelectorChars))
          .max(INPUT_LIMITS.maxSignals)
          .default([]),
        ignoredSignals: z
          .array(z.string().trim().min(1).max(INPUT_LIMITS.maxSelectorChars))
          .max(INPUT_LIMITS.maxSignals)
          .default([]),
      })
      .strict(),
    sources: z.array(sourceSchema).min(1).max(SOURCE_LIMITS.maxSources),
    policy: z
      .object({
        minimumSubstantiveProbability: boundedProbability.default(POLICY_DEFAULTS.minimumSubstantiveProbability),
        minimumBreakingProbability: boundedProbability.default(POLICY_DEFAULTS.minimumBreakingProbability),
        minimumChoiceConfidence: boundedProbability.default(POLICY_DEFAULTS.minimumChoiceConfidence),
        minimumScoreConfidence: boundedProbability.default(POLICY_DEFAULTS.minimumScoreConfidence),
        alertFromRelevanceLevel: boundedScore.default(POLICY_DEFAULTS.alertFromRelevanceLevel),
        alertFromImpactLevel: boundedScore.default(POLICY_DEFAULTS.alertFromImpactLevel),
        maxCandidatesPerSource: z.number().int().min(1).max(SOURCE_LIMITS.maxCandidatesPerSource).optional(),
        sourceConcurrency: z.number().int().min(1).max(SOURCE_LIMITS.maxConcurrency).optional(),
      })
      .partial()
      .default({}),
    options: z
      .object({
        generateSummary: z.boolean().default(true),
        includeUnchangedSources: z.boolean().default(false),
      })
      .partial()
      .default({}),
  })
  .strict();

export type MonitorInput = z.infer<typeof monitorInputSchema>;

// Validate cross-source identities after schema parsing and collapse equivalent URLs.
export function validateMonitorInput(value: unknown): MonitorInput {
  const input = monitorInputSchema.parse(value);
  const sourceIds = new Set<string>();
  const normalizedUrls = new Map<string, MonitorSource>();
  const sources: MonitorSource[] = [];

  for (const source of input.sources) {
    if (sourceIds.has(source.id)) throw new Error(`DUPLICATE_SOURCE_ID:${source.id}`);
    sourceIds.add(source.id);
    const normalized = normalizedSourceUrl(source.url);
    const previous = normalizedUrls.get(normalized);
    if (previous) {
      const sameConfiguration =
        previous.fetchMode === source.fetchMode &&
        previous.contentSelector === source.contentSelector &&
        JSON.stringify(previous.ignoreSelectors) === JSON.stringify(source.ignoreSelectors);
      if (!sameConfiguration) throw new Error(`DUPLICATE_SOURCE_CONFLICT:${source.id}`);
      continue;
    }
    normalizedUrls.set(normalized, source);
    sources.push(source);
  }
  return { ...input, sources };
}
