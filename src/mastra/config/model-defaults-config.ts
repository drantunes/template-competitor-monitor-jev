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
