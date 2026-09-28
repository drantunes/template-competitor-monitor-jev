# Competitor monitor with Jev

This Mastra template safely collects public pages, creates durable baselines, and records exact changed section evidence for later Jev classification. F1 deliberately does not call a model, run a browser, create schedules, or generate summaries.

Install with `npm install`, copy `.env.example` to `.env`, then use `npm run dev` and open `http://127.0.0.1:4111` in your browser. Use the configured loopback address rather than the CLI's `localhost` link so Studio and its API share an origin. Local mode binds to `127.0.0.1`. Production requires `EXECUTION_MODE=production` and a nonblank `MASTRA_API_TOKEN`; native SimpleAuth protects the Mastra routes. The token is static, has no expiry or user management, and rotation means changing the environment value and restarting the process.

Framework workflow state uses `MASTRA_DATABASE_URL`; immutable page snapshots and pending evidence use the separate `MONITOR_DATABASE_URL`. Defaults live under `.data/` at the project root. Mastra CLI 1.31.3 native start supplies that root directly. Its native dev launcher runs inside `.mastra/output` and supplies the enclosing `.mastra` directory with `MASTRA_DEV=true`; the template recognizes that launcher shape and keeps durable defaults one level above it. Direct execution and every other explicit `MASTRA_PROJECT_ROOT` use that root unchanged, otherwise the working directory is used. Relative `file:` overrides resolve against the selected root, and missing local parent directories are created at startup. Absolute file URLs, remote URLs and `file::memory:` retain their meaning. The template retains history and does not provide a reset endpoint.

Mastra clears `.mastra/` while building. If an earlier checkout stored databases there, stop the process and back them up before another dev/build invocation, then deliberately copy them to `.data/` without overwriting existing files. The application does not automatically migrate or delete earlier databases.

Candidate limits bound later classification work. Collection stores every detected change atomically; overflow returns `CANDIDATE_LIMIT` with pending evidence and a partial result. Pending evidence and its warning survive a restart or an unchanged subsequent capture.

Normalization `f1-semantic-v2` includes rendered link destinations in source evidence. Existing `f1-semantic-v1` source profiles remain preserved and reject a later run as `SOURCE_ID_REBOUND`; create a new source ID for deliberately changed normalization rules rather than silently changing its historical baseline.

Only public HTTP(S) sources are accepted. DNS answers, redirects, and robots retrieval are checked before collection. Authenticated pages, private networks, browser fallback, CAPTCHA handling, and content that fails validation are rejected. This is an F1 implementation slice rather than a completed demo.
