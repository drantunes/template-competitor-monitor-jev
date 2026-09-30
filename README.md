# Competitor monitor with Jev

This private Mastra template monitors configured public competitor pages. It stores immutable baselines, detects changed sections, uses Jev to classify changed evidence, and keeps the route, evidence, model provenance, and optional grounded summary in local storage for review.

The template has not been published or accepted upstream. It is a local implementation intended for evaluation and contribution review.

## Quickstart

Use Node `^22.22.0 || >=24.12.0` and npm.

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:4111`. Local mode binds to loopback. Use that address instead of the CLI's `localhost` link so Studio and its API share an origin.

Create a monitor input in Studio with public `pricing`, `changelog`, and `documentation` URLs. The first run creates authentic baselines. A later run fetches the same public URLs and reports the observed result: unchanged, changed, partial, deferred, or failed. The template cannot manufacture a third party change.

Use `EXECUTION_MODE=production` only with a nonblank `MASTRA_API_TOKEN`. Native SimpleAuth then protects Mastra routes. The token is static: rotate it by changing the environment value and restarting the process.

## How the monitor uses Mastra and Jev

Mastra owns the typed workflow, native Classifier registration, durable framework storage, schedules, observability, and the optional report agent. The monitor's classifier is registered once with the six Jev questions: Choice for change type, Score for relevance and business impact, and Boolean judgments for substantive, breaking, and cosmetic changes.

The workflow retrieves that registered classifier and calls its native audit boundary directly:

```ts
const result = await classifier.evaluate({
  state,
  abortSignal: classificationAbortSignal(abortSignal),
  maxRetries: TIMING.maxRetries,
});
```

The routing policy retains fractional scores, Choice confidence, warnings, rounding, requested and reported model identities. Low confidence, conflicting signals, mixed evidence, and unknown categories route to review. Missing usage or unverified model identity remains unknown; it is never treated as free or verified.

No model call is made for a new baseline or unchanged source. A changed candidate reserves the conservative Jev budget before native evaluation. Optional OpenAI summaries receive only bounded stored evidence and never replace a classification decision.

## Configuration and data

Copy `.env.example` and keep credentials outside version control. `MASTRA_DATABASE_URL` stores Mastra state; `MONITOR_DATABASE_URL` stores immutable snapshots, pending evidence, decisions, and provider reservations. Relative `file:` URLs resolve from the project root, outside the disposable `.mastra` build directory.

Jev defaults to direct TypeSafe access with `TYPESAFE_AI_API_KEY`, `JEV_MODEL=jev-latest`, and `JEV_COST_ATTESTATION=typesafe-jev-2026-09-27:jev-latest`. The optional `JEV_ACCESS_MODE=vercel-gateway` route uses only `AI_GATEWAY_API_KEY`, fixed `https://ai-gateway.vercel.sh/typesafe/v1`, model `typesafe-ai/jev`, and `JEV_COST_ATTESTATION=vercel-ai-gateway-typesafe-2026-09-29:typesafe-ai/jev`. The application never accepts a configurable Gateway destination. OpenAI summaries require `OPENAI_API_KEY` and a matching `OPENAI_COST_ATTESTATION`. Attestations mean the operator has verified account model access and tariff. `JEV_BUDGET_USD` and `OPENAI_BUDGET_USD` can only lower their separate project ceilings.

The weekly native schedule is opt-in and needs a long lived process. It is never created during installation or startup.

## Evaluation and live demonstration

`npm run test:evaluation` runs the versioned F5 synthetic dataset through an official `@mastra/evals/vitest` workflow assertion. The fixtures cover unchanged, navigation, promotion, pricing, packaging, feature, deprecation, security, documentation, acquisition failure, prompt injection, and unsupported language. Calibration and held-out examples have separate IDs. The report exposes model-question-rule versions, sample denominators, route accuracy, alert precision/recall, review recall, evidence attribution, and summary support. A zero denominator is reported as undefined.

Synthetic fixtures are test-only. They are never a demo substitute.

`npm run test:live-evaluation` is a bounded live selector. It fails when any prerequisite is absent; it does not skip or simulate the result. Before running it, export the credentials and attestation from `.env` and provide `F5_LIVE_INPUT_JSON` with one real public pricing, changelog, and documentation source. A first run creates authentic baselines; a prior baseline is verified against the same URL when it exists. The selector runs the existing workflow and storage budget controls. It may honestly report unchanged pages, site errors, budget deferral, or classified changes; it does not guarantee an alert or a model call.

In Studio, switch to **JSON** input before submitting this payload. The generated form currently serializes numeric policy defaults as strings and sends empty optional numeric fields, which fails schema validation. The JSON payload uses numeric policy values and a lower supported content floor for these public pages.

```bash
set -a
source .env
set +a
export F5_LIVE_INPUT_JSON='{"monitorId":"f5-smoke-20260929","runMode":"manual","profile":{"name":"Operator","interests":["pricing","documentation"],"prioritySignals":[],"ignoredSignals":[]},"sources":[{"id":"cloudflare-pricing","label":"Cloudflare plans","url":"https://www.cloudflare.com/plans/","kind":"pricing","minContentChars":100,"ignoreSelectors":[]},{"id":"cloudflare-changelog","label":"Cloudflare changelog","url":"https://developers.cloudflare.com/changelog/","kind":"changelog","minContentChars":100,"ignoreSelectors":[]},{"id":"cloudflare-docs","label":"Cloudflare Workers documentation","url":"https://developers.cloudflare.com/workers/","kind":"documentation","minContentChars":100,"ignoreSelectors":[]}],"policy":{"minimumSubstantiveProbability":0.7,"minimumBreakingProbability":0.65,"minimumChoiceConfidence":0.6,"minimumScoreConfidence":0.6,"alertFromRelevanceLevel":2,"alertFromImpactLevel":2,"maxCandidatesPerSource":3,"sourceConcurrency":3},"options":{"generateSummary":false,"includeUnchangedSources":true}}'
npm run test:live-evaluation
```

The live selector does not store a synthetic baseline, use mocked acquisition, or inject classifier answers. This documented demo constrains `generateSummary` to `false`; a real summary requires a separately configured OpenAI account and attestation. It permits a first run to create real baselines and records failed sources as failures. `F5_LIVE_EVALUATION_CASES_JSON` is a JSON array of labeled held-out cases with `id`, `split`, `expectedRoute`, `evidence`, `classificationState`, and `provenance.reviewedAt`. Cases are explicitly either synthetic held-out or operator-supplied experiments and are never live-site provenance. Check provider availability, account billing, and remaining project budget before it is run.

Each held-out case retains the bounded state that is sent to Jev and the matching evidence used for routing. The approved three-case synthetic subset is in `tests/fixtures/f5-live-held-out-cases.json`; label it `synthetic-held-out-live-jev-experiment` and never present it as a public-site demo. Replace the example values with a reviewed capture and `operator-supplied-live-jev-experiment` only when its provenance is independently retained.

```bash
export F5_LIVE_EVALUATION_CASES_JSON="$(cat tests/fixtures/f5-live-held-out-cases.json)"
```

```json
[
  {
    "id": "reviewed-held-out-001",
    "split": "held-out",
    "expectedRoute": "alert",
    "evidence": {
      "id": "reviewed-held-out-001",
      "sectionKey": "pricing",
      "beforeText": "Pro costs $29.",
      "afterText": "Pro costs $39.",
      "beforeExcerpt": "Pro costs $29.",
      "afterExcerpt": "Pro costs $39.",
      "excerptTruncated": false,
      "kind": "modified"
    },
    "classificationState": {
      "evidence": {
        "id": "reviewed-held-out-001",
        "sectionKey": "pricing",
        "beforeText": "Pro costs $29.",
        "afterText": "Pro costs $39.",
        "beforeExcerpt": "Pro costs $29.",
        "afterExcerpt": "Pro costs $39.",
        "excerptTruncated": false,
        "kind": "modified"
      },
      "source": { "id": "pricing", "label": "Pricing", "url": "https://example.com/pricing", "kind": "pricing" },
      "interests": ["pricing"],
      "prioritySignals": [],
      "ignoredSignals": []
    },
    "provenance": { "kind": "operator-supplied-live-jev-experiment", "reviewedAt": "2026-09-29T20:16:01Z" }
  }
]
```

The `npm_quickstart_runs_demo_workflow` selector remains blocked until an operator runs `npm run dev`, submits the documented input through Studio, and retains the native workflow run ID. Set `F5_MANUAL_STUDIO_SMOKE_RECORD_JSON` to JSON containing `nativeWorkflowRunId`, `monitorId`, `sourceId`, `sourceUrl`, and `observedAt`. The selector verifies that record against the durable monitor run and baseline for the same configured URL; a configuration preflight is not treated as the proof. Independent review still checks the operator's Studio evidence.

## Checks

```bash
npm run format:check
npm run typecheck
npm run build
npm run test:unit
npm run test:classification
npm run test:integration
npm run test:browser
npm run test:reports
npm run test:evaluation
```

## Customization and limitations

Adjust source lists, profile interests, and policy thresholds in a monitor input. Operational ceilings and validated environment overrides live in `src/mastra/config/`; keep changes there so budget, timeout, and concurrency behavior remain explicit.

The monitor only acquires public HTTP(S) pages. It does not log in, bypass CAPTCHA, submit forms, discover URLs autonomously, send alerts to external systems, or create hosted infrastructure. Browser fallback and summary generation remain bounded optional capabilities. Live results are measurements of the supplied URLs and account configuration, not a performance, cost, speed, or accuracy guarantee.
