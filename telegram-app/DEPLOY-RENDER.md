# Deploy to Render

## Prepared

- `render.yaml` is in the repository root.
- The app now listens to Render's `PORT` automatically.
- The site is ready for `SNAPSHOT_SOURCE_MODE=push`, so bot data can be sent to `POST /api/ingest/event-delay`.

## Deploy Steps

1. Push this project to GitHub.
2. Sign in to [Render](https://render.com/).
3. Click `New` -> `Blueprint`.
4. Connect the GitHub repository.
5. Render will detect `render.yaml` and create the web service.
6. Fill in these secrets:
   - `BOT_TOKEN`
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `EVENT_INGEST_TOKEN`
7. Wait for deploy and open `https://your-service.onrender.com/site`.

## Files For GitHub

- Commit `render.yaml`, source code, and the `*.example.*` config files.
- Do not commit `telegram-app/config/runtime-config.json`.
- Do not commit `run/config/funtime-event-watcher.properties`.
- Do not commit `telegram-app/data/`.

## Mod Settings

Set the watcher config like this:

```properties
site_sync_enabled=true
site_sync_url=https://YOUR-SITE.onrender.com/api/ingest/event-delay
site_sync_token=THE_SAME_EVENT_INGEST_TOKEN
```

## Free Plan Limits

- The site spins down after 15 minutes without inbound traffic.
- Wake-up after sleep can take about one minute.
- Local SQLite data is not guaranteed to survive restart or redeploy.

For a stable always-on setup, move later to `Starter` and use a persistent disk or an external database.
