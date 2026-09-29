const SUMMARY_FIXED_INPUT_TOKEN_RESERVE = 4_000;

export const MODEL_DEFAULTS = {
  // Alias, not a reproducible pin. JEV_MODEL may select a verified nonempty model ID.
  jev: 'jev-latest',
  // Approved evidence-to-prose model; no automatic substitution or env override.
  summary: 'openai/gpt-6-luna',
  // Approved reasoning setting for short structured summaries; no env override.
  summaryReasoning: 'none',
  // Tokens/request including prompt, evidence and schema; hard ceiling, no env override.
  summaryMaxInputTokens: 8_000,
  // Conservative token allowance for native instructions and the structured-output schema; hard ceiling, no env override.
  summaryFixedInputTokenReserve: SUMMARY_FIXED_INPUT_TOKEN_RESERVE,
  // UTF-8 bytes for JSON evidence. A byte bound conservatively upper-bounds prompt tokens and leaves the fixed reserve.
  summaryPromptMaxUtf8Bytes: 8_000 - SUMMARY_FIXED_INPUT_TOKEN_RESERVE,
  // Tokens/response; hard ceiling for concise structured output, no env override.
  summaryMaxOutputTokens: 800,
  // UTF-16 code units for supplied evidence. The UTF-8 byte bound is the input-token safety control.
  summaryEvidenceMaxCharacters: 4_000,
} as const;

// Structured summary response ceilings. They bound model prose and references independently of request tokens.
export const SUMMARY_LIMITS = {
  // Characters in the generated explanation; keeps reports concise and reviewable.
  explanationMaxCharacters: 2_000,
  // Evidence change IDs the model may cite in one summary.
  maxCitedChangeIds: 20,
  // Exact supplied excerpts the model may quote in one summary.
  maxQuotedEvidence: 20,
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
