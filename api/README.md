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

| File | Covers |
| --- | --- |
| `reward.test.js` | tiered reward maths, `HARD_MAX_MINUTES`, start-request validation |
| `focus-session.test.js` | session TTL, pruning, replay protection, tolerance window |
| `audio-categories.test.js` | audio config validation, plus the category helpers extracted from `index.html` / `admin.html` |
| `shop-sound-items.test.js` | backend audio config → shop "白噪音" items: shop-side name/description/price must win, matched by id or by audio file name |
| `ambient-audio.test.js` | `syncAmbientAudio` must not touch the player when the source did not change (reopening the shop used to restart the background noise) |
| `image-upload.test.js` | `POST /api/admin/assets/image`: auth, multipart handling, non-image rejection, and that an image keeps its own extension instead of the audio `.mp3` fallback |
| `cors.test.js` | origin parsing, trailing-slash normalisation, wildcard and `null` rules |
| `health.test.js` | `/api/health` answers immediately even while the data layer is still initialising |
| `bind-failure.test.js` | a failed `listen` must be loud: reports the real error code, does not print a misleading `listening`, and exits non-zero |
| `runtime-guard.test.js` | `ADMIN_API_KEY` handling, and a real process refusing to boot in production without it |

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
A trailing slash on an entry is stripped (`https://a.com/` behaves as `https://a.com`) — the `Origin` header never carries a path, and the match is an exact string comparison, so a stray slash would silently block the frontend.
Rejected origins get no CORS headers at all — that is what makes the browser block them. The rejection is logged with the offending origin.
If `CORS_ORIGINS` is unset the service falls back to a built-in list (localhost plus the two known test domains) and logs a warning; check `GET /api/health` → `cors: "fallback"` to detect that in production.

## Ports, and why the listen callback is checked

The service listens on `PORT` (default **8080**) and `HOST` (default `0.0.0.0`). The default is deliberately not `80`: the image runs as the non-root `node` user, and binding a privileged port below 1024 is rejected (`EACCES`) under some container runtimes and hardened security policies.

`EXTRA_PORTS` (comma separated, default `80`) makes the process listen on additional ports with the same app. It exists because the CloudBase console's service port may be pinned to `80` and not editable after the service is created — with both `8080` and `80` bound, the platform probe reaches the app whichever port it dials. A port that fails to bind is reported and skipped; the process only exits when **every** port fails, so a busy port cannot take the whole service down. Once the console's port is settled, set `EXTRA_PORTS` to an empty string to turn this off.

**If you change `PORT`, change the CloudBase console's service port to the same value.** The platform probe dials the container on the configured service port; a mismatch shows up as `connection refused` even though the app is running fine.

`app.listen(port, host, callback)` cannot be trusted to tell you whether the bind worked. Express 5 attaches that callback to the server's `error` event as well:

```js
app.listen = function listen() {
  var server = http.createServer(this)
  var args = slice.call(arguments)
  if (typeof args[args.length - 1] === 'function') {
    var done = args[args.length - 1] = once(args[args.length - 1])
    server.once('error', done)          // ← a failed bind calls the same callback
  }
  return server.listen.apply(server, args)
}
```

So a failed bind invokes the callback with an `Error` as its first argument. A callback that ignores its parameters therefore logs `listening` on a port nothing is listening on, and `server.address()` returns `null` — which is exactly the shape of the startup self-check line `监听地址异常（null）`. The process does not crash either, because Express consumed the `error` event.

That combination produced three failed deployments in a row: the app log said `listening`, the platform probe said `connection refused`, and no error was logged anywhere. The callback now takes the error, prints the code plus a plain-language cause, and exits non-zero. `bind-failure.test.js` locks this in.

The startup self-check still runs after a successful bind. It probes `/api/health` once via loopback and once via the container's own NIC address, so the log distinguishes "the app never listened" from "the app listens but the platform cannot reach it".

## Docker

```
docker build -t fishtank-api ./api
docker run --rm -p 8080:8080 \
  -e CORS_ORIGINS=https://your-app.example.com \
  -e ADMIN_API_KEY=... \
  -e CLOUDBASE_ENV_ID=... \
  fishtank-api
```

The image pins `node:22-bookworm-slim`, sets `NODE_ENV=production`, listens on `8080`, runs as the non-root `node` user and declares a `HEALTHCHECK` against `/api/health`. `.dockerignore` keeps host `node_modules`, `.env` and `uploads/` out of the image.

> **The image sets `NODE_ENV=production`, so `ADMIN_API_KEY` is mandatory.** A container started without it will exit immediately instead of serving an unprotected admin API. Set it in the CloudBase console (or with `-e`) before deploying this change.

Uploaded audio is written to `uploads/` inside the container by default, which is lost on restart. Either set `STORAGE_DRIVER=cloudbase` (default whenever `CLOUDBASE_ENV_ID` is set) or mount a persistent volume at that path and point `UPLOAD_DIR` at it.

## Upload storage, and what a failure looks like

There are two upload routes, and they differ only in the allowed extensions and the target folder:

| Route | Field | Extensions | Folder |
| --- | --- | --- | --- |
| `POST /api/admin/assets` | `file` | `AUDIO_EXTENSIONS` (`.mp3 .wav .ogg .m4a .aac .flac .webm`) | `sounds/` |
| `POST /api/admin/assets/image` | `file` | `IMAGE_EXTENSIONS` (`.png .jpg .jpeg .gif .webp .svg .bmp .avif`) | `images/` |

`POST /api/admin/assets` returns `data.fallbackError` **non-empty** when cloud storage was attempted and failed, and the file was instead written to the container's local disk. That local path (`/uploads/sounds/...`) only lives as long as the instance does — after a redeploy it is a guaranteed 404. The admin UI therefore refuses to write it into the audio config and keeps the previous value, so a failed upload never publishes a dead path.

`POST /api/admin/assets/image` behaves the same way and is what the 商品预览图 picker uses. Before it existed the admin page only put the *local file name* into the preview field, so the saved `previewImage` was something like `myfish.png` with no upload behind it — a guaranteed 404 in the shop.

> **Extension fallback is per kind.** `storedFileName(name, kind)` picks the fallback extension from the kind: unknown audio extensions become `.mp3`, unknown image extensions become `.png`. They used to share one code path, so an uploaded PNG was stored as `...png.mp3` — the static handler then served it as `audio/mpeg` and browsers refused to render it. `image-upload.test.js` locks this in.

`data.fallbackCode` carries the underlying error code. It exists because `@cloudbase/node-sdk` hides the real reason twice over:

- when `storage.getUploadMetadata` answers with an error payload, `uploadFile` destructures `data` off it and throws a bare `TypeError`, losing the code and message;
- when the COS upload itself fails, `uploadFile` does not throw at all — it *resolves* an `{ code, message, requestId }` object, so a `fileID` check alone reports only "no fileID".

So `saveCloudbase` probes `getUploadMetadata` after a failure and re-throws with the real `code` / `message` / `requestId` attached; `storeAudio` logs them and passes them through. If uploads fail, the server log line to read is:

```
云存储上传失败，已回落到本地存储（<code> | <message>） | requestId=...
```

Common causes, in the order worth checking:

1. **The bucket has no RLS policy.** In PG mode a bucket with *zero* policies refuses every API access, and the console says so right on the bucket page: 「该存储桶未配置任何 RLS 策略。所有通过 API 的访问都将被拒绝。」 Add any one policy (a read-only `SELECT` policy is enough) and it takes effect within 1–3 minutes. `service_role` has `BYPASSRLS`, so server-side uploads keep working without a write policy.
2. 云存储 not enabled for the env.
3. The API key lacking storage permission.
4. A wrong `CLOUDBASE_ENV_ID`.

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
- `POST /api/admin/assets/image` — multipart field `file`, images only, same cap; used for 商品预览图
- `GET /api/game/decorations`
- `GET /api/game/fish`
- `GET /api/game/focus`
- `GET /api/game/audio`
- `GET /uploads/sounds/*` — uploaded audio, range requests supported
- `GET /uploads/images/*` — uploaded 商品预览图
- `GET /api/health`

`GET /api/health` reports `storage` (driver), `repository` (`pending` / `ok` / `failed`), `cors` (`configured` / `fallback` / `all`) and `adminAuth` (`enabled` / `disabled`). It always answers 200 and **never waits on the data layer** — the repository connects to CloudBase RDB and seeds a dozen-odd rows over the network at boot, and a probe that blocks on that gets the whole version marked as a failed deployment even though the logs show the service listening. Read the `repository` field to see how the data layer is doing; the probe answer is not affected by it.

Admin reads draft data. Game endpoints return only `publishedData`. Saving a published config keeps the previous published version until the publish endpoint is called.
Audio configs store the permanent `cloud://` fileID; a playable URL is resolved on read. The same resolution runs for `audio` and `decorations` (`PUBLIC_PATH_RESOLVE_TYPES`), so a 商品预览图 stored as `cloud://...` is also turned into a usable URL on the way out — images need it just as much as audio does.
