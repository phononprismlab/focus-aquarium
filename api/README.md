# Fishtank API

`index.html` and `admin.html` only call this service. CloudBase SDK is used inside the API process and is never loaded by either HTML page.

## Local start

1. Install Node.js 20 or newer.
2. In this directory run `npm install`.
3. Run `npm start`.
4. Open `admin.html` or `index.html` from the workspace.

Without `CLOUDBASE_ENV_ID`, the API uses an in-memory repository for local development. Set `CLOUDBASE_ENV_ID` and optionally `CLOUDBASE_COLLECTION` to use CloudBase.
In production (`NODE_ENV=production`), `CLOUDBASE_ENV_ID` is required and the process exits instead of using the in-memory repository. Set `CORS_ORIGINS` to a comma-separated list of allowed frontend origins. For local pages opened directly from disk, use `null` as an allowed origin when needed.

Set `ADMIN_API_KEY` to protect all `/api/admin/*` endpoints. When set, admin requests must include an `x-admin-key` header matching this value. When unset (local dev), admin endpoints remain open. Always set this in production.

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
- `GET /api/game/decorations`
- `GET /api/game/fish`
- `GET /api/game/focus`
- `GET /api/health`

Admin reads draft data. Game endpoints return only `publishedData`. Saving a published config keeps the previous published version until the publish endpoint is called.
