import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// 默认存到 api/uploads，配 UPLOAD_DIR 可改到有持久卷的目录。
export const UPLOAD_ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(moduleDir, "uploads");

export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 15);
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm"];
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"];
export const AUDIO_MIME = /^audio\//i;

// ---------- 云存储的两种形态，上传通道完全不同 ----------
//   classic（传统模式）：getUploadMetadata 拿临时签名 → 客户端直传 COS。
//                        这就是 @cloudbase/node-sdk 的 uploadFile。
//   pg（PG 模式）      ：不走直传，统一经由 Storage API 网关，
//                        由网关在事务里同时写 storage.objects 与 COS，
//                        保证元数据与对象不出现孤儿状态。
//
// 本项目环境是 **PG 模式**（控制台里能看到 storage.objects / storage.buckets 上的 RLS 策略
// 就是铁证）。而 @cloudbase/node-sdk 3.x 只实现了 classic 通道 —— 它压根没有
// `app.storage.from(bucketId)` 这套原生桶语义。所以 PG 模式必须直接调网关 HTTP API。
//
// 用错通道的症状：上传必然失败，而且报错跟 RLS / 密钥权限都无关，怎么查都查不到点上。
export const CLOUDBASE_BUCKET = process.env.CLOUDBASE_BUCKET || "aquarium-assets";
export const PG_REF_SCHEME = "tcbpg://";

// 签名有效期：专注会话最长 120 分钟（seed 的 maxFocusDuration），
// 且前端只在「开商店」那一刻拉一次配置，URL 是那时签发的。
// 用 1h（3600）会中途静默 404（B3）。这里给到 24h（86400），
// 覆盖任意时长的专注 + 离线/挂机余量；这些是公开非敏感资源，长有效期无风险。
// 缓存时长（见文件下方 URL_TTL_MS）跟着它走，不要再单独写死一个数。
export const SIGN_TTL_SECONDS = Math.max(600, Number(process.env.CLOUDBASE_SIGN_TTL_SECONDS || 86400));

// ---------- 存储决策只有这一个来源（B9）----------
// 以前 currentDriver() 与 storageMode() 是两个各读各的环境变量的独立函数，
// 于是能配出自相矛盾的状态：STORAGE_DRIVER=local 却配着 CLOUDBASE_ENV_ID。
// 服务照常起来、日志里什么都不说，上传却全部写进容器本地磁盘 ——
// 实例一重建，配置里全是 404。现在两者都从 storagePlan() 派生，
// 并把「注定要出问题的组合」显式列出来，启动时就能看见。
export function storagePlan() {
  const configuredDriver = (process.env.STORAGE_DRIVER || "").trim().toLowerCase();
  const hasEnvId = Boolean(process.env.CLOUDBASE_ENV_ID);
  // 配了云环境就默认走云存储（云托管/云函数里密钥由环境注入）。
  const driver = configuredDriver || (hasEnvId ? "cloudbase" : "local");

  const configuredMode = (process.env.CLOUDBASE_STORAGE_MODE || "").trim().toLowerCase();
  // 默认 pg：本项目的环境就是 PG 模式。传统形态的环境请显式设 CLOUDBASE_STORAGE_MODE=classic。
  const mode = configuredMode === "classic" ? "classic" : "pg";
  const bucket = driver === "cloudbase" && mode === "pg" ? CLOUDBASE_BUCKET : "";
  const token = process.env.CLOUDBASE_STORAGE_TOKEN || process.env.CLOUDBASE_APIKEY || "";
  const production = String(process.env.NODE_ENV || "").toLowerCase() === "production";

  const problems = [];
  if (production && driver === "local") {
    problems.push(
      "生产环境的上传会写进容器本地磁盘（/uploads），实例重建后这些地址必然 404。" +
      "请设置 STORAGE_DRIVER=cloudbase 并配好 CLOUDBASE_ENV_ID / CLOUDBASE_APIKEY。"
    );
  }
  if (driver === "cloudbase" && !hasEnvId) {
    problems.push("STORAGE_DRIVER=cloudbase 但没有 CLOUDBASE_ENV_ID，所有上传都会失败。");
  }
  if (driver === "cloudbase" && mode === "pg" && !token) {
    problems.push("PG 模式需要 CLOUDBASE_APIKEY（或 CLOUDBASE_STORAGE_TOKEN），否则网关一律返回 401。");
  }
  return { driver, mode, bucket, hasEnvId, hasToken: Boolean(token), production, problems };
}

export function storageMode() {
  // 保持旧契约：默认 pg。调用方只关心「走哪条通道」，不关心驱动是谁。
  return storagePlan().mode === "classic" ? "classic" : "pg";
}

export function currentDriver() {
  return storagePlan().driver;
}

function defaultMimeFor(kind) {
  return kind === "image" ? "image/png" : "audio/mpeg";
}

// ---------- MIME 归一化（B7）----------
// multipart 里的 Content-Type 是客户端说了算的，实际会碰到三种脏数据：
//   1) 空的；2) application/octet-stream（curl、不少上传组件的默认值）；
//   3) 跟 kind 完全对不上的（音频接口里传 image/png）。
// 网关会把这个值原样写进 storage.objects 的元数据，之后浏览器按它决定怎么渲染 ——
// 存成 octet-stream 就是「文件在，但放不出来/显示不出来」。所以这里不信上报值，
// 只在它可信时采用，否则按后缀重算，最后才用 kind 的默认值兜底。
const MIME_BY_EXT = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".flac": "audio/flac", ".webm": "audio/webm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif"
};
// 这些值等于「客户端没告诉我们是什么」，不能当依据用。
const UNINFORMATIVE_MIME = new Set([
  "", "application/octet-stream", "binary/octet-stream",
  "application/x-www-form-urlencoded", "text/plain"
]);

export function effectiveMimeType(kind, originalName, reported = "") {
  const prefix = kind === "image" ? "image/" : "audio/";
  // 去掉 "; charset=..." 这类参数，统一小写。
  const cleaned = String(reported || "").split(";")[0].trim().toLowerCase();
  if (cleaned && !UNINFORMATIVE_MIME.has(cleaned) && cleaned.startsWith(prefix)) return cleaned;
  const ext = path.extname(String(originalName || "")).toLowerCase();
  return MIME_BY_EXT[ext] || defaultMimeFor(kind);
}

function pgGatewayBase() {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (!env) throw new Error("未配置 CLOUDBASE_ENV_ID，无法使用云存储");
  return `https://${env}.api.tcloudbasegateway.com`;
}

function pgToken() {
  const token = process.env.CLOUDBASE_STORAGE_TOKEN || process.env.CLOUDBASE_APIKEY || "";
  if (!token) throw new Error("未配置 CLOUDBASE_APIKEY，无法调用云存储网关");
  return token;
}

// 对象名里可能带子目录，逐段编码，别把 "/" 编掉。
function encodeObjectPath(objectName) {
  return String(objectName).split("/").map(encodeURIComponent).join("/");
}

export function pgRef(bucket, objectName) {
  return `${PG_REF_SCHEME}${bucket}/${objectName}`;
}

export function parsePgRef(ref) {
  const rest = String(ref).slice(PG_REF_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) throw new Error(`云存储引用格式不对：${ref}`);
  return { bucket: rest.slice(0, slash), objectName: rest.slice(slash + 1) };
}

// 网关的错误体是 {code, message, requestId}，原样带出来，
// 上层才能照旧填 fallbackError / fallbackCode，而不是只报一句"上传失败"。
async function pgFailure(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const error = new Error((payload && payload.message) || text || response.statusText || "网关未返回错误详情");
  error.code = String((payload && payload.code) || `HTTP_${response.status}`);
  error.requestId = String((payload && payload.requestId) || response.headers.get("x-request-id") || "");
  return error;
}

// PG 模式上传：POST /v1/storages/object/:bucketId/:objectName，body 直接是文件字节。
async function savePg(buffer, originalName, folder, kind, mimeType) {
  const bucket = CLOUDBASE_BUCKET;
  const objectName = `${folder}/${storedFileName(originalName, kind)}`;
  const endpoint = `${pgGatewayBase()}/v1/storages/object/${encodeURIComponent(bucket)}/${encodeObjectPath(objectName)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pgToken()}`,
      "Content-Type": effectiveMimeType(kind, originalName, mimeType),
      "x-upsert": "true"
    },
    body: buffer
  });
  if (!response.ok) throw await pgFailure(response);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  // 网关返回 { Id, Key }，Key 形如 "<bucket>/<objectName>"，就是持久化引用。
  const key = (payload && payload.Key) || `${bucket}/${objectName}`;
  const ref = `${PG_REF_SCHEME}${key}`;
  return { fileID: ref, path: ref, cloudPath: objectName, url: "", driver: "cloudbase" };
}

// PG 模式取下载链接：POST /v1/storages/object/sign/:bucketId/:objectName
async function pgSignedUrl(ref) {
  const { bucket, objectName } = parsePgRef(ref);
  const endpoint = `${pgGatewayBase()}/v1/storages/object/sign/${encodeURIComponent(bucket)}/${encodeObjectPath(objectName)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pgToken()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: SIGN_TTL_SECONDS })
  });
  if (!response.ok) throw await pgFailure(response);
  const payload = await response.json();
  const url = (payload && (payload.fullSignedURL || payload.signedURL)) || "";
  if (!url) throw new Error("云存储网关没有返回下载链接");
  return url;
}

// 音频和图片共用一套落盘逻辑，但兜底后缀必须分开：
// 图片曾经被一律兜成 .mp3，静态服务按后缀给 Content-Type，浏览器就渲染不出来。
const EXT_BY_KIND = {
  audio: { allowed: AUDIO_EXTENSIONS, fallback: ".mp3", stemFallback: "audio" },
  image: { allowed: IMAGE_EXTENSIONS, fallback: ".png", stemFallback: "image" }
};

function safeName(name, kind = "audio") {
  const rule = EXT_BY_KIND[kind] || EXT_BY_KIND.audio;
  const base = path.basename(String(name || rule.stemFallback));
  const ext = path.extname(base).toLowerCase();
  const stem = path.basename(base, ext)
    .replace(/[^\w一-龥.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || rule.stemFallback;
  return `${stem}${rule.allowed.includes(ext) ? ext : rule.fallback}`;
}

export function storedFileName(originalName, kind = "audio") {
  const name = safeName(originalName, kind);
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${stem}${ext}`;
}

export function audioFileName(originalName) {
  return storedFileName(originalName, "audio");
}

export function ensureUploadDir(folder = "sounds") {
  fs.mkdirSync(path.join(UPLOAD_ROOT, folder), { recursive: true });
  return UPLOAD_ROOT;
}

// 本地磁盘：Express 会把 /uploads 静态挂载到这个目录。
async function saveLocal(buffer, originalName, folder, kind = "audio") {
  ensureUploadDir(folder);
  const fileName = storedFileName(originalName, kind);
  const relative = `${folder}/${fileName}`;
  await fs.promises.writeFile(path.join(UPLOAD_ROOT, relative), buffer);
  return { url: `/uploads/${relative}`, path: relative, driver: "local" };
}

let cloudbaseApp = null;

async function getCloudbaseApp() {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (!env) throw new Error("未配置 CLOUDBASE_ENV_ID，无法使用云存储");
  if (cloudbaseApp) return cloudbaseApp;
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const options = { env };
  if (process.env.CLOUDBASE_SECRETID && process.env.CLOUDBASE_SECRETKEY) {
    options.secretId = process.env.CLOUDBASE_SECRETID;
    options.secretKey = process.env.CLOUDBASE_SECRETKEY;
  }
  // 云托管/云函数里可不传密钥；本地或其它环境用 API 密钥。
  if (process.env.CLOUDBASE_APIKEY) options.accessKey = process.env.CLOUDBASE_APIKEY;
  cloudbaseApp = cloudbase.init(options);
  return cloudbaseApp;
}

// 云开发对象存储：有 CLOUDBASE_ENV_ID 时启用，失败会自动回落到本地。
// 注意：临时访问链接会过期，所以持久化的是永久标识 fileID（cloud://...），
// 对外提供配置时再由 resolveAudioPaths 换成可用链接。
async function saveCloudbase(buffer, originalName, folder, kind = "audio") {
  const app = await getCloudbaseApp();
  const cloudPath = `${folder}/${storedFileName(originalName, kind)}`;
  let uploaded = null;
  let cause = null;
  try {
    uploaded = await app.uploadFile({ cloudPath, fileContent: buffer });
  } catch (error) {
    cause = error;
  }
  if (!uploaded || !uploaded.fileID) {
    const detail = await explainCloudbaseFailure(app, cloudPath, cause);
    const error = new Error(`云存储上传失败${detail.code ? `（${detail.code}）` : ""}：${detail.message || "上传接口没有返回 fileID"}`);
    error.code = detail.code || "STORAGE_NO_FILEID";
    error.requestId = detail.requestId || "";
    throw error;
  }
  return { fileID: uploaded.fileID, path: uploaded.fileID, cloudPath, url: "", driver: "cloudbase" };
}

// node-sdk 的 uploadFile 有两层静默：
//   1) 元数据接口（storage.getUploadMetadata）返回错误对象时，它直接对 undefined 解构，
//      抛出的是一句 TypeError，真正的原因（未开通云存储 / 无权限 / 环境不存在）全被吃掉；
//   2) COS 上传失败时它不抛异常，而是 resolve 一个 { code, message, requestId } 形状的错误对象。
// 旧代码只判断 fileID 是否存在，于是后台只能看到一句没有信息量的报错，无从定位。
// 失败后补一次 getUploadMetadata 探测（该方法是公开的），把真实的 code / message 带出来。
async function explainCloudbaseFailure(app, cloudPath, cause) {
  try {
    const meta = await app.getUploadMetadata({ cloudPath });
    if (meta && meta.code) {
      return { code: String(meta.code), message: messageOf(meta), requestId: String(meta.requestId || "") };
    }
  } catch (probeError) {
    return { code: String(probeError.code || probeError.name || "unknown"), message: messageOf(probeError), requestId: "" };
  }
  return { code: String((cause && cause.code) || (cause && cause.name) || "unknown"), message: messageOf(cause), requestId: "" };
}

// ---------- 签名链接的缓存与去重（B6）----------
// 公开接口每被请求一次，就要把它引用到的所有云文件换成签名链接。
// 冷缓存时一份配置可能有几十个引用，会一次性打出去，于是：
//   · 同一份配置里同一个文件被多处引用（一条音效既在商店又在调音面板）会各打各的；
//   · 并发请求（多个玩家同时开商店）会重复签同一个文件；
//   · 一次打太多会撞上网关限流，也会把容器可用的 socket 占满。
// 三层处理：结果缓存 → 同一引用的并发合并 → 全局并发上限。
const urlCache = new Map();
// 缓存时长跟着签名有效期走（取一半，留足安全边界）。
// 之前写死 30 分钟，而签名本身给到 24h，等于白白多打了几十倍网关。
export const URL_TTL_MS = Math.max(60_000, Math.floor(SIGN_TTL_SECONDS * 1000 * 0.5));
// 同一引用的并发解析合并到这一个 Promise 上。
const inflightResolves = new Map();
// 全局并发上限：多余的排队，不一次性轰出去。
const RESOLVE_CONCURRENCY = Math.max(1, Number(process.env.CLOUDBASE_RESOLVE_CONCURRENCY || 6));
let activeResolves = 0;
const resolveQueue = [];

function acquireResolveSlot() {
  if (activeResolves < RESOLVE_CONCURRENCY) {
    activeResolves += 1;
    return Promise.resolve();
  }
  return new Promise(resolve => resolveQueue.push(resolve));
}

function releaseResolveSlot() {
  const next = resolveQueue.shift();
  if (next) return next();
  activeResolves -= 1;
}

// 失败后短时间内不再重试，避免每个请求都打云存储接口。
const failedCache = new Map();
const FAILED_TTL_MS = 5 * 60 * 1000;
const messageOf = error => (error && error.message) ? error.message : String(error);

// 传统模式：把 fileID 换成临时链接。
async function classicTempUrl(fileID) {
  const app = await getCloudbaseApp();
  const { fileList } = await app.getTempFileURL({ fileList: [{ fileID, maxAge: 3600 }] });
  const url = fileList && fileList[0] ? fileList[0].tempFileURL : "";
  if (!url) throw new Error("获取云存储访问链接失败");
  return url;
}

async function cachedResolve(ref, loader) {
  const cached = urlCache.get(ref);
  if (cached && cached.expire > Date.now()) return cached.url;
  if ((failedCache.get(ref) || 0) > Date.now()) throw new Error("云存储链接暂不可用");
  // 同一个引用的并发解析共用一个请求（去重要在抢并发额度之前做，
  // 否则重复引用会白白占掉并发名额）。
  const running = inflightResolves.get(ref);
  if (running) return running;
  const task = (async () => {
    await acquireResolveSlot();
    try {
      const url = await loader();
      urlCache.set(ref, { url, expire: Date.now() + URL_TTL_MS });
      failedCache.delete(ref);
      return url;
    } catch (error) {
      failedCache.set(ref, Date.now() + FAILED_TTL_MS);
      throw new Error(messageOf(error));
    } finally {
      releaseResolveSlot();
      inflightResolves.delete(ref);
    }
  })();
  inflightResolves.set(ref, task);
  return task;
}

// 把持久化引用换成可直接使用的链接，两种形态都认：
//   tcbpg://<bucket>/<objectName>  → PG 模式（现在上传写的就是这种）
//   cloud://<env>.<bucket>/<path>  → 传统模式 fileID（历史数据，保留兼容）
// 其它值原样返回。
export async function resolveCloudUrl(ref) {
  const value = String(ref);
  if (value.startsWith(PG_REF_SCHEME)) return cachedResolve(value, () => pgSignedUrl(value));
  if (value.startsWith("cloud://")) return cachedResolve(value, () => classicTempUrl(value));
  return ref;
}

// 把配置里的云存储引用换成可播放 / 可显示的链接，其它值原样返回。
export async function resolveAudioPaths(value) {
  if (typeof value === "string") {
    if (!value.startsWith(PG_REF_SCHEME) && !value.startsWith("cloud://")) return value;
    try {
      return await resolveCloudUrl(value);
    } catch (error) {
      console.warn("云存储链接解析失败：", messageOf(error));
      return value;
    }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => resolveAudioPaths(item)));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveAudioPaths(item)]));
    return Object.fromEntries(entries);
  }
  return value;
}

// ---------- 存储自检（B4）----------
// 「密钥没有存储权限」这类问题，以前只有真去后台传一次才会暴露，而且失败还可能被
// 本地回落掩盖成「上传成功」。这里把两件事记下来给 /api/health 读：
//   · 最后一次真实上传的结果（成功 / 失败 + 错误码 + 时间）
//   · 网关这个域名通不通
// 两者都不参与任何请求路径，只是可观测性，不 await、不阻塞。
const storageState = {
  upload: "unverified",   // unverified | ok | failed
  lastError: "",
  lastErrorCode: "",
  lastErrorAt: 0,
  lastOkAt: 0,
  gateway: "unverified"   // unverified | reachable | unreachable | skipped
};

export function storageStatus() {
  return { ...storageState };
}

function recordStorageSuccess() {
  storageState.upload = "ok";
  storageState.lastOkAt = Date.now();
  storageState.lastError = "";
  storageState.lastErrorCode = "";
}

function recordStorageFailure(error) {
  storageState.upload = "failed";
  storageState.lastError = messageOf(error);
  storageState.lastErrorCode = String((error && error.code) || "");
  storageState.lastErrorAt = Date.now();
}

// 启动探测：只回答「网关这个域名通不通」，不校验凭据、不写任何对象。
// 网关对未鉴权请求回 401，所以拿到任何 HTTP 响应就算通 —— 它把
// 「环境 ID 写错 / 容器出不了网」和「密钥没权限」这两类问题分开了，
// 而后者才是真正需要一次真实上传才能暴露的（那部分由 storageState.upload 负责）。
export async function probeStorageGateway({ timeoutMs = 5000 } = {}) {
  if (storagePlan().driver !== "cloudbase") {
    storageState.gateway = "skipped";
    return storageState.gateway;
  }
  const env = process.env.CLOUDBASE_ENV_ID || "未配置";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${pgGatewayBase()}/`, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    storageState.gateway = "reachable";
    console.log(`存储探测：网关可达（HTTP ${response.status}${response.status === 401 ? "，未鉴权属正常" : ""}），env=${env}`);
  } catch (error) {
    storageState.gateway = "unreachable";
    if (!storageState.lastError) storageState.lastError = messageOf(error);
    console.warn(`存储探测：网关不可达（${messageOf(error)}），env=${env}。上传会失败，请核对环境 ID 与容器出网。`);
  }
  return storageState.gateway;
}

// 本地回落只在「云存储暂时不可用、但你正在本机开发」时才该发生。
// 生产环境回落 = 把 /uploads/xxx 这种只在这台实例活着时有效的地址写进配置，
// 实例一重建就全 404，而且失败被吞掉、后台还以为存成功了（B8）。
// 所以生产环境直接抛错，让调用方看到真实原因；确实需要回落时用 ALLOW_LOCAL_FALLBACK=1 显式打开。
export function localFallbackAllowed() {
  if (/^(1|true|yes)$/i.test(String(process.env.ALLOW_LOCAL_FALLBACK || "").trim())) return true;
  return String(process.env.NODE_ENV || "").toLowerCase() !== "production";
}

// kind: "audio" | "image" —— 决定兜底后缀与落盘子目录的默认命名口径。
export async function storeAudio({ buffer, originalName, kind = "audio", mimeType = "" }, folder = "sounds") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空");
  const driver = currentDriver();
  if (driver === "cloudbase") {
    try {
      // PG 模式与传统模式是两条完全不同的通道，别混用（见文件顶部注释）。
      const stored = storageMode() === "pg"
        ? await savePg(buffer, originalName, folder, kind, mimeType)
        : await saveCloudbase(buffer, originalName, folder, kind);
      recordStorageSuccess();
      return stored;
    } catch (error) {
      // 这条日志要带上错误码和 requestId，让"为什么云存储不可用"能一次查清，而不是反复猜。
      recordStorageFailure(error);
      const detail = [error.code, error.message].filter(Boolean).join(" | ");
      const requestSuffix = error.requestId ? ` | requestId=${error.requestId}` : "";
      if (!localFallbackAllowed()) {
        console.error(`云存储上传失败，且当前环境不允许回落到本地磁盘（${detail}）${requestSuffix}`);
        const failure = new Error(
          `云存储上传失败（${error.code || "unknown"}）：${error.message}。` +
          "当前环境不允许写入容器本地磁盘 —— 那样存下来的地址在实例重建后必然 404。" +
          "请先修复云存储配置再上传。"
        );
        failure.code = error.code;
        failure.requestId = error.requestId;
        throw failure;
      }
      console.warn(`云存储上传失败，已回落到本地存储（${detail}）${requestSuffix}`);
      const local = await saveLocal(buffer, originalName, folder, kind);
      return { ...local, fallbackFrom: "cloudbase", fallbackError: error.message, fallbackCode: error.code || "" };
    }
  }
  return saveLocal(buffer, originalName, folder, kind);
}
