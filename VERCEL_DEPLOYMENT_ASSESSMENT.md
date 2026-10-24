# Vercel deployment assessment

## Verdict: not deployable as a fully working application on Vercel as-is

Bulltrade currently runs a long-lived Node HTTP server (server.js) that serves static pages and API routes. It uses a JSON file database, local uploads, startup initialization, and recurring market-refresh timers. Vercel Node.js functions are request-oriented serverless functions; their filesystem is read-only except for temporary /tmp storage. Function instances may be recycled or run concurrently, so local JSON files and in-process timers cannot safely provide shared persistent state.

A static-only deployment may serve the public frontend, but it will not make authentication, admin, KYC uploads, wallet, ledger, trading, and market APIs work.

## Recommended deployment layout

- Frontend: Vercel can host the static public assets.
- API/backend: keep the current long-running Node server on a persistent Node host until it is deliberately refactored into serverless-compatible handlers.
- Database: migrate the JSON data store to transactional PostgreSQL before multi-instance/serverless API execution.
- Uploads: move KYC and other user uploads to private object storage with strict access controls; do not expose identity documents through public static hosting.
- Market refresh: use a scheduled worker/cron or external market-data service with shared cache storage, not an uncoordinated timer per function instance.
- Secrets: configure secrets in deployment environment settings only, never in Git or browser code.

## Requirements for a full Vercel migration

1. Refactor HTTP routing into serverless request handlers.
2. Replace local JSON persistence with transactional PostgreSQL and a serverless-safe connection strategy.
3. Move uploads to private object storage and review upload size limits.
4. Replace process-level intervals and startup-only work with scheduled jobs or queues.
5. Test sessions, cookies, API body limits, cold starts, concurrency, admin workflows, and retry behavior on preview deployments.
6. Run database corruption and live-trading guard tests plus full integration tests against staging.
7. Keep live execution disabled until an approved exchange execution adapter and order reconciliation pass sandbox tests.

## Safety note

Current quote providers do not provide exchange order execution. Bulltrade intentionally rejects live-mode orders. Do not remove that guard to make a deployment appear functional. A successful frontend deployment is not proof that the backend, database, funding, or trading is production-ready.
