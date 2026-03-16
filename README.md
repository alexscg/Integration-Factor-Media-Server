# Integration Factor Media Server

API for the Integration Factor app (albums, tracks, auth, contact, cover proxy). See the main [deployment plan](../Integration-Factor-UI/docs/DEPLOYMENT_PLAN.md) and [TASKS](../Integration-Factor-UI/docs/TASKS.md).

## Local

```bash
cp .env.example .env
# Edit .env: set MONGODB_URI, ADMIN_TOKEN, etc. For sync/enrich from Utils, set SYNC_ENRICH_ENABLED=true
npm install
npm start
```

Runs at `http://localhost:3001`. Health: `GET /api/health`.

## Deploy (Render / Fly)

- **Build:** `npm install`
- **Start:** `node server/api.cjs`
- Set env in the dashboard (do **not** set `SYNC_ENRICH_ENABLED` in cloud).
