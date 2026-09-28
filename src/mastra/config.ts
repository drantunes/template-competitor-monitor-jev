import { basename, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

// Fixed ceilings have no environment override unless explicitly documented below.
export const SOURCE_LIMITS = {
  // Sources/run; hard ceiling. MAX_SOURCES accepts integers from 1 to this value.
  maxSources: 20,
  // Source tasks in parallel; starter seed. SOURCE_CONCURRENCY accepts 1..maxConcurrency.
  defaultConcurrency: 3,
  // Concurrent source tasks; hard ceiling to bound outbound fan-out.
  maxConcurrency: 5,
  // Evaluations/source in parallel; fixed at one to preserve order and bound reservations.
  candidateConcurrency: 1,
  // Candidates/run/source; seed. CANDIDATES_PER_SOURCE accepts 1..maxCandidatesPerSource.
  defaultCandidatesPerSource: 20,
  // Candidates/run/source; hard ceiling. Remaining candidates must stay pending.
  maxCandidatesPerSource: 50,
  // Decoded bytes/source; hard ceiling. Reject oversized responses rather than truncate.
  maxHtmlBytes: 2 * 1024 * 1024,
  // Normalized characters/source; hard ceiling. Excess content is explicitly incomplete.
  maxNormalizedChars: 100_000,
  // Characters/before or after excerpt; hard ceiling, preserving semantic blocks.
  maxExcerptChars: 8_000,
  // Serialized candidate characters, excluding fixed questions; hard ceiling for model input.
  maxCandidateStateChars: 24_000,
  // Characters/source; quality seed. Per-source overrides may lower it to a positive integer.
  minContentChars: 200,
  // Alphabetic characters required before local language identification; below this language is uncertain.
  minLanguageLetters: 30,
  // Missing-text fraction; quality seed in [0, 1]. Quarantine above it; no env override.
  maxContentLossRatio: 0.6,
  // Redirect hops/acquisition; hard ceiling. Validate the destination at every hop.
  maxRedirects: 5,
} as const;

// Milliseconds unless stated otherwise; fixed bounds with no environment overrides.
export const TIMING = {
  // HTTP attempt deadline, including body reads; abort stalled acquisition.
  httpAttemptMs: 15_000,
  // Browser attempt deadline, including rendering and extraction.
  browserAttemptMs: 30_000,
  // Whole Jev evaluation deadline, including all SDK retries.
  jevCallMs: 30_000,
  // Whole summary generation deadline, including retries.
  summaryCallMs: 30_000,
  // Shared acquisition deadline across HTTP, browser fallback and retry waits.
  acquisitionDeadlineMs: 120_000,
  // Additional transient attempts; hard ceiling, never retry invalid or blocked input.
  maxRetries: 2,
  // Acquisition backoff starter delay; SDK model retries retain their native algorithm.
  retryInitialDelayMs: 500,
  // Dimensionless acquisition backoff multiplier; fixed exponential growth.
  retryBackoffFactor: 2,
  // Maximum acquisition retry wait; longer Retry-After must defer the source.
  retryMaxDelayMs: 5_000,
  // Live evaluation test deadline; use explicitly on relevant tests, not on ordinary unit tests.
  evalTestTimeoutMs: 180_000,
} as const;

// HTTP protocol values used by acquisition. They are protocol semantics rather than operator-tunable limits.
export const HTTP_STATUS = {
  // Inclusive successful-response range.
  successMin: 200,
  successMaxExclusive: 300,
  // Redirect response codes that require a separately validated destination.
  redirects: [301, 302, 303, 307, 308],
  // Missing robots.txt permits collection under the default robots policy.
  notFound: 404,
  // Transient responses eligible for the bounded acquisition retry policy.
  tooManyRequests: 429,
  serverErrorMin: 500,
} as const;

// Calibration seeds, not measured accuracy claims. No environment overrides;
// policy changes must be versioned and persisted with the effective run settings.
export const POLICY_DEFAULTS = {
  // P(substantive=true) in [0, 1]; minimum for substantive routing.
  minimumSubstantiveProbability: 0.7,
  // P(breaking=true) in [0, 1]; minimum for breaking-change routing.
  minimumBreakingProbability: 0.65,
  // Native Choice confidence in [0, 1]; below this requires review.
  minimumChoiceConfidence: 0.6,
  // Native Score confidence in [0, 1]; below this requires review.
  minimumScoreConfidence: 0.6,
  // Relevance rubric level in [0, 4]; minimum for an alert, without rounding answers.
  alertFromRelevanceLevel: 2,
  // Impact rubric level in [0, 4]; minimum for an alert, without rounding answers.
  alertFromImpactLevel: 2,
  // P(cosmetic=true) in [0, 1]; minimum for cosmetic routing.
  minimumCosmeticProbability: 0.7,
  // Probability difference in [0, 1] between the top two choices; below this requires review.
  minimumChoiceMargin: 0.1,
} as const;

// Fixed classifier contract boundaries; no overrides.
export const RUBRIC = {
  // Inclusive probability/confidence lower bound (dimensionless).
  minProbability: 0,
  // Inclusive probability/confidence upper bound (dimensionless).
  maxProbability: 1,
  // Inclusive score lower bound; scores represent ordered rubric levels.
  minScore: 0,
  // Inclusive score upper bound; fractional answers remain fractional.
  maxScore: 4,
} as const;

export const MODEL_DEFAULTS = {
  // Alias, not a reproducible pin. JEV_MODEL may select a verified nonempty model ID.
  jev: 'jev-latest',
  // Approved evidence-to-prose model; no automatic substitution or env override.
  summary: 'openai/gpt-6-luna',
  // Approved reasoning setting for short structured summaries; no env override.
  summaryReasoning: 'none',
  // Tokens/request including prompt, evidence and schema; hard ceiling, no env override.
  summaryMaxInputTokens: 8_000,
  // Tokens/response; hard ceiling for concise structured output, no env override.
  summaryMaxOutputTokens: 800,
} as const;

// Cumulative project authorization in USD, including retries, tests and demonstrations.
// These values do not implement accounting: callers still need durable reservations.
export const PROJECT_BUDGET_USD = {
  // Hard Jev ceiling. JEV_BUDGET_USD may only lower it; zero disables paid calls.
  jev: 4.5,
  // Hard OpenAI ceiling. OPENAI_BUDGET_USD may only lower it; zero disables paid calls.
  openai: 5,
} as const;

// Reference tariff only; verify actual billing before paid work. No environment overrides.
export const PRICING_REFERENCE = {
  checkedAt: '2026-09-27',
  // Tokens per quoted pricing unit; fixed unit conversion, not a tokenizer estimate.
  tokensPerPricingUnit: 1_000_000,
  // USD/million input tokens; published TypeSafe reference, subject to account verification.
  jevInputUsdPerMillion: 0.042,
  // USD/million output tokens; published free output, not proof that usage is absent.
  jevOutputUsdPerMillion: 0,
  // USD/million uncached standard input tokens for the approved OpenAI model.
  openaiInputUsdPerMillion: 0.1,
  // USD/million standard output tokens for the approved OpenAI model.
  openaiOutputUsdPerMillion: 0.5,
} as const;

// Dataset planning seeds, not quality targets. No environment overrides.
export const EVAL_DEFAULTS = {
  // Snapshot pairs covering the regression families; positive integer seed.
  regressionPairs: 24,
  // Labeled calibration pairs; positive integer seed, disjoint from held-out examples.
  calibrationPairs: 12,
  // Labeled held-out pairs; positive integer seed, excluded from calibration.
  heldOutPairs: 12,
  // Concurrent live evaluations; fixed at one to keep project spending sequential.
  concurrency: 1,
} as const;

// Example native schedule only; importing configuration never creates a schedule.
export const SCHEDULE_DEFAULTS = { cron: '0 9 * * 1', timezone: 'UTC' } as const;

export const SERVER_DEFAULTS = {
  executionMode: 'local',
  localHost: '127.0.0.1',
  productionHost: '0.0.0.0',
} as const;

export const STORAGE_DEFAULTS = {
  // Framework LibSQL database URL; local durable workflow state is isolated from app evidence.
  mastraUrl: 'file:./.data/mastra.db',
  // Application-owned LibSQL database URL for immutable snapshots and pending evidence.
  monitorUrl: 'file:./.data/competitor-monitor.db',
} as const;

/** Resolve relative file URLs without changing absolute, remote, or in-memory database URLs. */
export function resolveDatabaseUrl(value: string, projectRoot: string) {
  if (!value.startsWith('file:') || value === 'file::memory:') return value;
  const base = pathToFileURL(`${resolve(projectRoot)}${sep}`);
  return value.startsWith('file://') ? new URL(value).href : new URL(value.slice('file:'.length), base).href;
}

/**
 * Mastra CLI 1.31.3's native dev launcher starts in `.mastra/output` and supplies the enclosing
 * `.mastra` directory as MASTRA_PROJECT_ROOT with MASTRA_DEV=true. Durable application state
 * belongs at the project root, one level above that disposable build directory. Keep every other
 * explicit root unchanged, including native start and direct operator overrides.
 */
function resolveStorageRoot(environment: Readonly<Record<string, string | undefined>>, configuredRoot?: string) {
  if (!configuredRoot) return process.cwd();
  const resolvedRoot = resolve(configuredRoot);
  return environment.MASTRA_DEV === 'true' && basename(resolvedRoot) === '.mastra'
    ? dirname(resolvedRoot)
    : resolvedRoot;
}

export const OVERRIDE_BOUNDS = {
  // Smallest usable count for source/candidate work; fixed integer lower bound.
  minCount: 1,
  // USD; zero explicitly disables paid work, negative budgets are invalid.
  minBudgetUsd: 0,
} as const;

export const INPUT_LIMITS = {
  // Characters/identifier; bounds stable public monitor and source identities.
  maxIdentifierChars: 160,
  // Characters/human-readable source label or profile name; bounds workflow state.
  maxLabelChars: 300,
  // Characters/operator organization context; bounds untrusted workflow input and later model state.
  maxOrganizationContextChars: 4_000,
  // Characters/URL and CSS selector; bounds validation work before network access.
  maxUrlChars: 2_048,
  maxSelectorChars: 500,
  // Array lengths; bounds untrusted invocation metadata.
  maxSelectors: 30,
  maxSignals: 50,
  maxInterests: 9,
} as const;

function numericEnvironmentValue(fallback: number, min: number, max: number, integer = false) {
  let value = z.number().min(min).max(max);
  if (integer) value = value.int();

  return z.preprocess(raw => {
    if (raw === undefined) return fallback;
    // Reject blank strings instead of letting JavaScript convert them to zero.
    if (typeof raw !== 'string' || raw.trim() === '') return Number.NaN;
    return Number(raw);
  }, value);
}

const environmentSchema = z
  .object({
    EXECUTION_MODE: z.enum(['local', 'production']).default(SERVER_DEFAULTS.executionMode),
    MASTRA_API_TOKEN: z.string().optional(),
    MAX_SOURCES: numericEnvironmentValue(
      SOURCE_LIMITS.maxSources,
      OVERRIDE_BOUNDS.minCount,
      SOURCE_LIMITS.maxSources,
      true,
    ),
    SOURCE_CONCURRENCY: numericEnvironmentValue(
      SOURCE_LIMITS.defaultConcurrency,
      OVERRIDE_BOUNDS.minCount,
      SOURCE_LIMITS.maxConcurrency,
      true,
    ),
    CANDIDATES_PER_SOURCE: numericEnvironmentValue(
      SOURCE_LIMITS.defaultCandidatesPerSource,
      OVERRIDE_BOUNDS.minCount,
      SOURCE_LIMITS.maxCandidatesPerSource,
      true,
    ),
    JEV_BUDGET_USD: numericEnvironmentValue(
      PROJECT_BUDGET_USD.jev,
      OVERRIDE_BOUNDS.minBudgetUsd,
      PROJECT_BUDGET_USD.jev,
    ),
    OPENAI_BUDGET_USD: numericEnvironmentValue(
      PROJECT_BUDGET_USD.openai,
      OVERRIDE_BOUNDS.minBudgetUsd,
      PROJECT_BUDGET_USD.openai,
    ),
    JEV_MODEL: z.string().trim().min(1).default(MODEL_DEFAULTS.jev),
    MASTRA_DATABASE_URL: z.string().trim().min(1).default(STORAGE_DEFAULTS.mastraUrl),
    MONITOR_DATABASE_URL: z.string().trim().min(1).default(STORAGE_DEFAULTS.monitorUrl),
    MASTRA_PROJECT_ROOT: z.string().trim().min(1).optional(),
  })
  .superRefine((env, context) => {
    const token = env.MASTRA_API_TOKEN;
    if (env.EXECUTION_MODE === 'production' && !token?.trim()) {
      context.addIssue({ code: 'custom', path: ['MASTRA_API_TOKEN'], message: 'Required in production' });
    } else if (token?.trim() && /\s/.test(token)) {
      context.addIssue({ code: 'custom', path: ['MASTRA_API_TOKEN'], message: 'Token must not contain whitespace' });
    }
  });

/** Call once at startup. Importing constants neither reads credentials nor starts services. */
export function loadConfig(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    // Report only variable names. Zod inputs and supplied credential values must stay private.
    const variables = [...new Set(result.error.issues.map(issue => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${variables.join(', ')}`);
  }

  const env = result.data;
  const projectRoot = resolveStorageRoot(environment, env.MASTRA_PROJECT_ROOT);
  return {
    executionMode: env.EXECUTION_MODE,
    // Never log or persist this object: it contains the server credential.
    server: {
      host: env.EXECUTION_MODE === 'local' ? SERVER_DEFAULTS.localHost : SERVER_DEFAULTS.productionHost,
      apiToken: env.EXECUTION_MODE === 'production' ? env.MASTRA_API_TOKEN : undefined,
    },
    sources: {
      maxSources: env.MAX_SOURCES,
      concurrency: env.SOURCE_CONCURRENCY,
      candidatesPerSource: env.CANDIDATES_PER_SOURCE,
    },
    models: { ...MODEL_DEFAULTS, jev: env.JEV_MODEL },
    budgetUsd: { jev: env.JEV_BUDGET_USD, openai: env.OPENAI_BUDGET_USD },
    storage: {
      mastraUrl: resolveDatabaseUrl(env.MASTRA_DATABASE_URL, projectRoot),
      monitorUrl: resolveDatabaseUrl(env.MONITOR_DATABASE_URL, projectRoot),
    },
  };
}

export type MonitorConfig = ReturnType<typeof loadConfig>;
