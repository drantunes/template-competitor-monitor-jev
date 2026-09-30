// Cumulative project authorization in USD, including retries, tests and demonstrations.
// These values do not implement accounting: callers still need durable reservations.
export const PROJECT_BUDGET_USD = {
  // Hard Jev ceiling. JEV_BUDGET_USD may only lower it; zero disables paid calls.
  jev: 4.5,
  // Hard OpenAI ceiling. OPENAI_BUDGET_USD may only lower it; zero disables paid calls.
  openai: 5,
} as const;

export const JEV_ACCESS = {
  direct: 'direct',
  vercelGateway: 'vercel-gateway',
  vercelGatewayBaseUrl: 'https://ai-gateway.vercel.sh/typesafe/v1',
  vercelGatewayModel: 'typesafe-ai/jev',
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

export const CLASSIFICATION_LIMITS = {
  // Tokens/native evaluation request; published TypeSafe full-context ceiling used for conservative reservation.
  jevMaxInputTokens: 65_536,
  // Integer microdollars/USD; avoids floating-point budget comparison drift in durable reservations.
  usdReservationUnits: 1_000_000,
} as const;

// Maximum standard-rate cost of one bounded Luna summary; reserve before dispatch.
export const SUMMARY_RESERVATION_USD =
  (MODEL_DEFAULTS.summaryMaxInputTokens * PRICING_REFERENCE.openaiInputUsdPerMillion +
    MODEL_DEFAULTS.summaryMaxOutputTokens * PRICING_REFERENCE.openaiOutputUsdPerMillion) /
  PRICING_REFERENCE.tokensPerPricingUnit;
import { MODEL_DEFAULTS } from './model-defaults-config';
