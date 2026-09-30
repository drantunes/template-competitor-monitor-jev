# Competitor Monitor with Jev

Tell the chat which product to monitor, share its public page URLs, and describe what matters to your team. The monitor compares pricing, changelog, and documentation pages with saved history. Jev classifies the changes, and OpenAI explains the results with source links and before and after excerpts.

## Why we built this

A page edit does not always mean a competitor changed its pricing or product. Navigation updates and promotional copy can distract from useful signals. This monitor keeps the evidence visible, uses Jev to assess each change, and applies a policy to ignore it, record it, request review, or flag an alert. First captures and unchanged pages without pending work need no Jev call.

## Prerequisites

- **[OpenAI API key](https://platform.openai.com/api-keys)**: set `OPENAI_API_KEY` for the Studio chat. The chat uses `openai/gpt-6-luna` to understand requests and explain results. Your account needs access to this model.
- **[TypeSafe AI API key](https://console.typesafe.ai)**: set `TYPESAFE_AI_API_KEY` to classify changes with Jev. Direct TypeSafe access is the default, using `jev-latest`.
- **[Vercel AI Gateway key (alternative)](https://vercel.com/docs/ai-gateway/authentication-and-byok)**: instead of a TypeSafe key, set `JEV_ACCESS_MODE=vercel-gateway` and `AI_GATEWAY_API_KEY`. This route uses `typesafe-ai/jev`; your Gateway account needs access to it. OpenAI chat still uses `OPENAI_API_KEY` directly.
- **[Google Chrome (optional)](https://www.google.com/chrome/)**: install Chrome for the local Stagehand fallback when a page needs browser rendering. Ordinary HTTP collection needs no browser account.

## Quickstart 🚀

1. **Create your project**
   - Run `npx create-mastra@latest competitor-monitor --template https://github.com/drantunes/template-competitor-monitor-jev --no-install`.
   - Run `cd competitor-monitor`, then `npm ci`. This repository URL works before catalog publication.
2. **Add your API keys**
   - Run `cp .env.example .env` and fill in the values described under Prerequisites.
   - Keep `EXECUTION_MODE=local`. Local databases are created automatically.
3. **Start the dev server**
   - Run `npm run dev`.
   - Open [Mastra Studio](http://localhost:4111), select the **Competitor Monitor** agent (`competitor-monitor-agent`), and send the example below with a real company and its page URLs.
   - The first successful check saves each page as a baseline. It does not report those pages as new changes. You enter the URLs in chat; no manual JSON setup is required.

## Try it out

- **Monitor a product, like the [XYZ] company.** Send this message in Studio, with a real company and operational links for pricing, changelog, and documentation:

  ```plaintext
  Monitor [XYZ] for our product team.
  Pricing: https://[XYZ].com/pricing
  Changelog: https://[XYZ].com/changelog
  Documentation: https://[XYZ].com/docs
  Focus on pricing, plan changes, new features, and deprecations.
  Check these pages now and explain the result.
  ```

- **Check again later.** In the same conversation, send “Check the same [XYZ] pages again.” The monitor compares current content with saved captures. Unchanged pages without pending work skip Jev; actual changes include their evidence and routing decision. Each request runs one check.
- **Explain a change.** Ask “Which changes need review, and what changed before and after?” The chat explains the returned evidence and identifies uncertainty or incomplete work.
- **Monitor your own product list.** Send another product name, its public URLs, and your interests. The chat asks for missing information and creates a separate monitor. Reuse the same monitor and source identities for later comparisons; give replacement URLs new source IDs.

Each monitor accepts **3 sites by default**. Set `MAX_SOURCES` to another value from 1 to 20 to change this limit. `SOURCE_CONCURRENCY=3` separately controls how many sites are fetched at once (maximum 5). Use a separate `monitorId` for each competitor so their histories remain independent.

## Customization

- Ask your coding agent: “Explore the acquisition, Jev questions, and routing policy. Propose a plan to prioritize pricing and deprecation changes while preserving exact evidence and uncertainty review.”
- Adjust the interests, priorities, or ignored signals you give the chat. The accepted `interests` values and other workflow input fields are defined in [`src/mastra/schemas.ts`](src/mastra/schemas.ts). For collection rules, use `contentSelector` and `ignoreSelectors` in workflow inputs. Operational defaults live in `src/mastra/config/`.

## How the monitor uses Mastra and Jev

The OpenAI agent converts your request into input for the native `competitorMonitor` workflow. Chat and structured runs share the same collection, storage, and classification logic. Chat runs explain the report directly, avoiding a separate summary-generation call.

The native Jev Classifier asks six questions: change type, relevance, business impact, and whether the change is substantive, breaking, or cosmetic. The change-type choices and routing decisions are defined in [`src/mastra/lib/classification.ts`](src/mastra/lib/classification.ts). Code combines these answers with the routing policy. Low confidence or conflicting answers go to review. Jev evaluates evidence; OpenAI provides conversation and explanations.

Reports retain exact excerpts, source URLs, question-set and routing-rule versions, and available model identities. Missing provider information stays unknown.

The native integration in `classifier.ts`, `index.ts`, and `candidate-classification.ts` uses this constructor, registration, and evaluation pattern:

```typescript
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { Classifier } from '@mastra/core/classifier';
import { Mastra } from '@mastra/core/mastra';

const competitorChangeClassifier = new Classifier({
  id: CLASSIFIER_ID,
  model: createTypeSafeAi({
    apiKey: config.credentials.jevApiKey,
    baseURL: config.jev.baseURL,
  }).evaluationModel(config.models.jev),
  questions: COMPETITOR_CHANGE_QUESTIONS,
});
const mastra = new Mastra({
  classifiers: { competitorChange: competitorChangeClassifier },
  workflows: { competitorMonitor: workflow },
});
const result = await mastra.getClassifierById(CLASSIFIER_ID).evaluate({
  state,
  abortSignal: classificationAbortSignal(abortSignal),
  maxRetries: TIMING.maxRetries,
});
```

Here `config` comes from the template configuration, `workflow` is the existing monitor workflow, and `state` is the bounded before/after evidence and profile built by `classificationState`. The workflow supplies `abortSignal`. The template's constants, questions, and state builder live in `src/mastra/lib/classification.ts`. Direct access selects `jev-latest`; the optional Gateway configuration supplies its compatible endpoint and `typesafe-ai/jev` model. The workflow owns routing and persisted audit data from `result.answers`, native confidence, usage, warnings, rounding, and response identity.

## Configuration and data

- **Structured runs:** the **competitorMonitor** workflow (`competitor-monitor`) remains available in Studio for integrations or direct input. Its JSON input accepts `monitorId`, `profile`, and `sources`; the chat builds this input for you. Without OpenAI, you can use this workflow directly, but chat and generated summaries are unavailable. In Studio, use JSON input with numeric policy values: the current generated Form can serialize numeric defaults as strings and fail input validation.
- **Storage:** `.data/mastra.db` holds Mastra state; `.data/competitor-monitor.db` holds snapshots, pending changes, and decisions. Override these paths with `MASTRA_DATABASE_URL` and `MONITOR_DATABASE_URL`. Preserve both databases across restarts. Page history is durable; the agent uses the conversation supplied with each request, so repeat the product, URLs, and interests when starting a new conversation.
- **Recurring checks:** the scheduler is disabled by default. Add real monitor inputs to the ignored `scheduled-monitors.json` file and set `ENABLE_MONITOR_SCHEDULER=true` as described below. Mastra then registers one schedule per monitor on startup. A long-lived Mastra process must stay running for daily checks.
- **Production mode:** set `EXECUTION_MODE=production` and a nonblank `MASTRA_API_TOKEN` for native SimpleAuth protection. The static token has no expiry; rotate it by changing the value and restarting. Local mode binds to `127.0.0.1`.

For a production build, run `npm run build`, then `npm start`. The npm postbuild lifecycle preserves the scoped Stagehand security override in the generated installation; keep that lifecycle when adapting build commands.

### Accepted values

The workflow input contract is in [`src/mastra/schemas.ts`](src/mastra/schemas.ts). Its enumerated fields are:

| Field                 | Accepted values                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profile.interests`   | `pricing`, `packaging`, `product_feature`, `availability`, `deprecation`, `policy_terms`, `security_compliance`, `documentation`, `company_announcement` (choose 1 to 9) |
| `sources[].kind`      | `pricing`, `changelog`, `documentation`, `blog`, `status`, `other`                                                                                                       |
| `sources[].fetchMode` | `auto` (default), `http`, `browser`                                                                                                                                      |
| `runMode`             | `baseline`, `manual` (default), `scheduled` (set automatically for configured schedules)                                                                                 |

The environment choices for `EXECUTION_MODE`, `JEV_ACCESS_MODE`, and `ENABLE_MONITOR_SCHEDULER` are defined in [`src/mastra/config/index.ts`](src/mastra/config/index.ts). The report routes `alert`, `review`, `record`, and `ignore` are defined in [`src/mastra/lib/classification.ts`](src/mastra/lib/classification.ts) and validated in [`src/mastra/lib/reporting.ts`](src/mastra/lib/reporting.ts).

The meanings of every `profile.interests` value, plus descriptions of the other workflow fields, are documented beside their definitions in [`src/mastra/schemas.ts`](src/mastra/schemas.ts). For example, `packaging` concerns plan contents, limits, and entitlements; `security_compliance` concerns security controls, certifications, and compliance commitments. The workflow passes the selected interests **with these definitions**, your `organizationContext`, and any `prioritySignals` or `ignoredSignals` to Jev with each before/after excerpt. Jev uses the [change-type and relevance criteria](src/mastra/lib/classification.ts) to judge the evidence. These profile fields guide its assessment; they do not exclude evidence or force an alert. To customize what an interest means, edit `INTEREST_DEFINITIONS` in the schema and the corresponding classifier criteria.

`runMode: "baseline"` is for an initial capture: it creates snapshots for sources that have no baseline, leaves existing baselines untouched, and defers pending classification. `runMode: "manual"` also creates missing baselines on the first check, but later checks compare pages and classify changes; it does not send notifications. `runMode: "scheduled"` compares and classifies like `manual` and saves durable notification events when classification completes. Enabled providers receive those events, including decisions recovered from earlier pending checks. The default is `manual`.

### Daily schedule

The versioned [`scheduled-monitors-example.json`](scheduled-monitors-example.json) shows two competitors. Create your local, ignored `scheduled-monitors.json` from that example; a fresh checkout does not include the local configuration file. To configure daily monitoring:

1. Run `cp scheduled-monitors-example.json scheduled-monitors.json`. Replace every `.example` URL with a real public page. Keep one JSON array entry per competitor, with a unique `monitorId` and up to 3 `sources` by default.
2. Set this value in `.env`:

```dotenv
ENABLE_MONITOR_SCHEDULER=true
```

`ENABLE_MONITOR_SCHEDULER=false` is the default, so merely creating the JSON file does not start monitoring. When enabled, startup requires a nonempty, valid `scheduled-monitors.json`; it fails clearly if the file is missing or invalid. The registered workflow checks each configured competitor **daily at 09:00 UTC** (`0 9 * * *`). This is a fixed daily time, not a timer that starts 24 hours after the previous run. The first successful check saves a baseline; later checks compare against it. To change the time or timezone, edit `SCHEDULE_DEFAULTS` in `src/mastra/config/model-defaults-config.ts`. The developer can also replace the native scheduler or register schedules programmatically with `ensureDailyMonitorSchedule` in `src/mastra/lib/schedules.ts`. Restart the Mastra process after changing the JSON file or `.env`. View or pause schedules in Mastra Studio's Schedules area.

### Notification output

Scheduled classification saves an immutable notification event with its decision. The final `notify-competitor-changes` step sends pending events to the enabled `NotificationProvider` destinations. The example provider writes one dated Markdown report per decision event to `.data/reports/`, including the source URL and exact before/after excerpts. Keep this directory and both databases on persistent storage.

Baselines and manual chat checks neither enqueue nor dispatch notifications. Failed classification retains pending evidence; a later scheduled check can classify and notify it even when the page is unchanged. Failed providers are attempted again on later scheduled checks, while successful provider receipts prevent repeat delivery. Other providers are still attempted, and the run records `notificationFailures`. Events retain the destinations enabled when the classification completed; a removed provider's delivery waits until that provider ID is enabled again.

The Markdown provider replays the same event into the same filename. A custom provider must deduplicate `eventId` to handle a process stopping after delivery but before its receipt is saved. The provider contract does not guarantee exactly-once delivery for external services.

Enable, remove, or add provider instances in `src/mastra/notifications/index.ts`. Implement the small `NotificationProvider` contract in `src/mastra/notifications/types.ts` for the delivery you want: an API call, email, or a [Mastra Channel](https://mastra.ai/docs/channels). Channels connect an agent to a chat platform; sending a scheduled report to a chosen destination still needs provider code that posts that report. The Markdown writer is an example local notification, not an external message.

## Evaluation

Run `npm run test:evaluation` for the versioned synthetic dataset and native Mastra workflow assertions. Calibration and held-out examples are separate, and metrics include their denominators. See [CONTRIBUTING.md](CONTRIBUTING.md) for implementation checks.

## Limitations

The monitor collects public English-language pages that allow automated access, without login or CAPTCHA. Redirected document destinations must also permit access through robots.txt.

Browser fallback is intentionally restricted. It permits same-origin scripts and modules served with a validated JavaScript MIME type. A strict CSP and denying proxy block cross-origin resources, network fetch/XHR, frames, workers, images, fonts, forms, and navigation. Sites that depend on those capabilities may fail to render useful content. It does not browse autonomously or perform page actions.

A page with pending evidence can still call Jev on an unchanged check. Missing configuration, transient classification failures, and candidate limits preserve that work for a later check. Manual recovery stays silent; only decisions completed by scheduled checks create notification events.

The English-only restriction is due to Jev's current language performance: English is its primary training language and where its accuracy is currently best. Jev can process other languages, but they do not perform equally well, so this template limits monitored pages to English for more reliable change classification. See TypeSafe AI's [Jev language support documentation](https://docs.typesafe.ai/models#language-support).

## About Mastra templates

This independently maintained template combines native Mastra agents, workflows, and Classifier evaluation with TypeSafe AI's Jev. It is being prepared for contribution to Mastra and is not yet available in the template catalog.

[Want to contribute?](CONTRIBUTING.md)
