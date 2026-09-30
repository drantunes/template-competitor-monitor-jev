# Contributing

This repository is a local Mastra template under evaluation. It has not been submitted to or accepted by the Mastra project.

Use npm with the committed `package-lock.json`, TypeScript ESM, single quotes, semicolons, two-space indentation, and the repository Prettier configuration. Keep operational defaults in `src/mastra/config/`, use the native Mastra workflow, classifier, storage, schedule, and evaluation APIs where they fit, and avoid wrappers that only forward framework calls.

Run the relevant deterministic checks before proposing a change:

```bash
npm run format:check
npm run typecheck
npm run build
npm run test:classification
npm run test:integration
npm run test:browser
npm run test:reports
npm run test:evaluation
```

Add or adjust functional tests for observable workflow behavior and persisted effects. Keep synthetic fixtures in tests. Do not use fixtures, mocked providers, or replayed pages in a live demonstration. `npm run test:live-evaluation` requires operator supplied credentials, verified tariffs, and real public URLs; a first run may create the genuine baseline. It is not a routine contributor check.

Do not commit credentials, private page content, provider headers, generated database files, evaluation logs containing secrets, or campaign drafts. Keep any proposed X and LinkedIn drafts outside this Git checkout until a separately authorized release process requests them.
