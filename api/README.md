# Fishtank API

`index.html` and `admin.html` only call this service. CloudBase SDK is used inside the API process and is never loaded by either HTML page.

## Local start

1. Install Node.js 20 or newer.
2. In this directory run `npm install`.
3. Run `npm start`.
4. Open `admin.html` or `index.html` from the workspace.

Without `CLOUDBASE_ENV_ID`, the API uses an in-memory repository for local development. Set `CLOUDBASE_ENV_ID` and optionally `CLOUDBASE_COLLECTION` to use CloudBase.
In production (`NODE_ENV=production`), `CLOUDBASE_ENV_ID` is required and the process exits instead of using the in-memory repository.

Set `ADMIN_API_KEY` to protect all `/api/admin/*` endpoints. When set, admin requests must include an `x-admin-key` header matching this value. When unset (local dev), admin endpoints remain open. Always set this in production, otherwise anyone can rewrite the published config and upload files.

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
