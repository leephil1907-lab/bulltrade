# Frontend and backend deployment

## Architecture

- **Frontend:** Vercel serves the existing multi-page static site from `public/`.
- **Backend:** deploy the full Node.js server as a persistent service on Render (or another persistent Node host). Do not deploy `server.js` itself as a Vercel serverless function: it owns startup, timers, local files and database initialization.
- **API bridge:** `api/[...path].js` forwards same-origin `/api/*` requests to the configured backend. This preserves the existing frontend's relative API URLs and forwards session cookies and `Set-Cookie` responses.

## Vercel setup

1. Import `leephil1907-lab/bulltrade` into Vercel.
2. Keep the project root at the repository root; the static output directory is `public`.
3. Add the environment variable `BULLTRADE_BACKEND_URL` with the exact HTTPS base URL of the deployed backend (no trailing path such as `/api`).
4. Deploy a preview first. If this variable is missing, API calls deliberately return HTTP 503 instead of silently pretending the app is connected.
5. Configure the production domain only after login, logout, signup, session cookies, admin routes and API calls pass staging checks.

## Backend setup

1. Deploy using the repository's `render.yaml` blueprint or equivalent Node service configuration. Build: `npm install`; start: `npm start`.
2. Configure `NODE_ENV=production`, a unique strong `JWT_SECRET`, `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD` in the host's secret manager.
3. Use persistent storage for database files or migrate to managed PostgreSQL before production financial/customer workloads. Do not rely on an ephemeral filesystem for the only copy of the database.
4. Restrict admin access, rotate credentials, and configure transactional email and market-data providers as needed.
5. Do not accept real customer KYC documents until private durable object storage, access controls, retention/deletion rules and backups have been verified. Git history is not an appropriate long-term KYC document store.

## Customer data and backups

- `BACKUP_REPO` must name a **private** repository. Backup reads/writes now fail closed if GitHub does not confirm private visibility.
- The GitHub backup mechanism is a temporary continuity measure, not a substitute for a transactional database or secure document storage.
- Keep backup tokens and all credentials in host environment secrets only. Never put them in Vercel client variables (for example, variables prefixed with `NEXT_PUBLIC_`) or commit them.
- Do not make the operational data repository public. It may contain password hashes, personal information, KYC records and deposit proofs.

## Trading safety

Bulltrade's current quote adapters do not execute exchange orders. Live-mode orders must remain blocked. Do not enable real-money execution until a real provider adapter, sandbox verification, transactional order/ledger persistence, idempotency, reconciliation, permission review and jurisdiction-specific compliance review are complete.
