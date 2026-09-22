# Fishtank API

`index.html` and `admin.html` only call this service. CloudBase SDK is used inside the API process and is never loaded by either HTML page.

## Local start

1. Install Node.js 20 or newer.
2. In this directory run `npm install`.
3. Run `npm start`.
4. Open `admin.html` or `index.html` from the workspace.

Without `CLOUDBASE_ENV_ID`, the API uses an in-memory repository for local development. Set `CLOUDBASE_ENV_ID` and optionally `CLOUDBASE_COLLECTION` to use CloudBase.
In production (`NODE_ENV=production`), `CLOUDBASE_ENV_ID` is required and the process exits instead of using the in-memory repository.

## Tests

Unit tests need no server:

```
npm test
```

The HTTP smoke test starts and stops its own server, so one command is enough:

```
npm run test:smoke
```

That script picks port 4173 and the throwaway key `test-key-123` on its own. Options: `node test/smoke-standalone.mjs --port 4180`, or `--keep` to leave the server running afterwards.

If you prefer to drive the server yourself, start it in one terminal and point the smoke script at it from another:

```
# terminal 1 — PowerShell
$env:PORT="4173"; $env:ADMIN_API_KEY="test-key-123"; node server.js

# terminal 2 — PowerShell
$env:BASE_URL="http://127.0.0.1:4173"; $env:ADMIN_API_KEY="test-key-123"; node test/smoke.mjs
```

On Git Bash / WSL use `PORT=4173 ADMIN_API_KEY=test-key-123 node server.js` instead.

> **Windows PowerShell:** if `npm test` fails with `npm.ps1 cannot be loaded because running scripts is disabled on this system`, the machine's execution policy blocks the npm wrapper script — it is not a project problem. Use `npm.cmd test`, or run `node test/run-unit.mjs` directly, or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` (no admin rights needed).
>
> If the machine has an `http_proxy` set, `curl` against `localhost` may be intercepted and return 502 — add `--noproxy '*'`. The test scripts use Node's `fetch`, which ignores the proxy, so they are unaffected.

Set `ADMIN_API_KEY` to protect all `/api/admin/*` endpoints. When set, admin requests must include an `x-admin-key` header matching this value. When unset (local dev), admin endpoints remain open.

In production (`NODE_ENV=production`) `ADMIN_API_KEY` is **required**: without it the process prints an error and exits with a non-zero code, because an unauthenticated admin API lets anyone rewrite the published config and upload files. The value is trimmed, and keys shorter than 16 characters trigger a warning (but still start).

## CORS

Allowed frontend origins come from `CORS_ORIGINS` (comma separated). Each entry can be:

| Entry | Meaning |
| --- | --- |
| `https://app.example.com` | exact origin |
| `*.tcloudbaseapp.com` | any subdomain — useful because CloudBase assigns random subdomains |
| `null` | pages opened directly from disk (`file://`) |
| `*` | every origin, only if you accept that |

Requests without an `Origin` header (curl, server-to-server, same origin) are not affected by the list.
Rejected origins get no CORS headers at all — that is what makes the browser block them. The rejection is logged with the offending origin.
If `CORS_ORIGINS` is unset the service falls back to a built-in list (localhost plus the two known test domains) and logs a warning; check `GET /api/health` → `cors: "fallback"` to detect that in production.

## Docker

```
docker build -t fishtank-api ./api
docker run --rm -p 8080:80 \
  -e CORS_ORIGINS=https://your-app.example.com \
  -e ADMIN_API_KEY=... \
  -e CLOUDBASE_ENV_ID=... \
  fishtank-api
```

The image pins `node:22-bookworm-slim`, sets `NODE_ENV=production`, runs as the non-root `node` user and declares a `HEALTHCHECK` against `/api/health`. `.dockerignore` keeps host `node_modules`, `.env` and `uploads/` out of the image.

> **The image sets `NODE_ENV=production`, so `ADMIN_API_KEY` is mandatory.** A container started without it will exit immediately instead of serving an unprotected admin API. Set it in the CloudBase console (or with `-e`) before deploying this change.

Uploaded audio is written to `uploads/` inside the container by default, which is lost on restart. Either set `STORAGE_DRIVER=cloudbase` (default whenever `CLOUDBASE_ENV_ID` is set) or mount a persistent volume at that path and point `UPLOAD_DIR` at it.

## Endpoints

- `GET /api/admin/decorations`
- `POST /api/admin/decorations`
- `PUT /api/admin/decorations/:id`
- `DELETE /api/admin/decorations/:id`
- `POST /api/admin/decorations/:id/publish`
- `GET /api/admin/fish`
- `POST /api/admin/fish`
- `PUT /api/admin/fish/:fishid`
- `DELETE /api/admin/fish/:fishid`
- `POST /api/admin/fish/:fishid/publish`
- `GET /api/admin/focus`
- `PUT /api/admin/focus/focus`
- `POST /api/admin/focus/focus/publish`
- `GET /api/admin/audio`
- `PUT /api/admin/audio/audio`
- `POST /api/admin/audio/audio/publish`
- `POST /api/admin/assets` — multipart field `file`, audio only, `MAX_UPLOAD_MB` cap (default 15)
- `GET /api/game/decorations`
- `GET /api/game/fish`
- `GET /api/game/focus`
- `GET /api/game/audio`
- `GET /uploads/sounds/*` — uploaded audio, range requests supported
- `GET /api/health`

`GET /api/health` reports `storage` (driver), `repository` (`ok` / `failed`), `cors` (`configured` / `fallback` / `all`) and `adminAuth` (`enabled` / `disabled`). It always answers 200 so a bad config does not throw the container into a restart loop — read the fields instead.

Admin reads draft data. Game endpoints return only `publishedData`. Saving a published config keeps the previous published version until the publish endpoint is called.
Audio configs store the permanent `cloud://` fileID; a playable URL is resolved on read.
