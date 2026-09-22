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

export function storageMode() {
  const configured = (process.env.CLOUDBASE_STORAGE_MODE || "").trim().toLowerCase();
  if (configured === "pg" || configured === "classic") return configured;
  // 默认 pg：本项目的环境就是 PG 模式。传统形态的环境请显式设 CLOUDBASE_STORAGE_MODE=classic。
  return "pg";
}

function defaultMimeFor(kind) {
  return kind === "image" ? "image/png" : "audio/mpeg";
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
      "Content-Type": mimeType || defaultMimeFor(kind),
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
    body: JSON.stringify({ expiresIn: 3600 })
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

// 临时链接缓存：云开发的访问链接有有效期，缓存时间要明显短于有效期。
const urlCache = new Map();
const URL_TTL_MS = 30 * 60 * 1000;

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
  try {
    const url = await loader();
    urlCache.set(ref, { url, expire: Date.now() + URL_TTL_MS });
    failedCache.delete(ref);
    return url;
  } catch (error) {
    failedCache.set(ref, Date.now() + FAILED_TTL_MS);
    throw new Error(messageOf(error));
  }
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

export function currentDriver() {
  const configured = (process.env.STORAGE_DRIVER || "").toLowerCase();
  if (configured) return configured;
  // 配了云环境就默认走云存储（云托管/云函数里密钥由环境注入）。
  return process.env.CLOUDBASE_ENV_ID ? "cloudbase" : "local";
}

// kind: "audio" | "image" —— 决定兜底后缀与落盘子目录的默认命名口径。
export async function storeAudio({ buffer, originalName, kind = "audio", mimeType = "" }, folder = "sounds") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空");
  const driver = currentDriver();
  if (driver === "cloudbase") {
    try {
      // PG 模式与传统模式是两条完全不同的通道，别混用（见文件顶部注释）。
      return storageMode() === "pg"
        ? await savePg(buffer, originalName, folder, kind, mimeType)
        : await saveCloudbase(buffer, originalName, folder, kind);
    } catch (error) {
      // 回落到容器本地磁盘只在这台实例活着的时候有效，实例一重建文件就没了，
      // 配置里留下的是一个必然 404 的地址。所以这条日志要带上错误码和 requestId，
      // 让"为什么云存储不可用"能一次查清，而不是反复猜。
      const detail = [error.code, error.message].filter(Boolean).join(" | ");
      console.warn(`云存储上传失败，已回落到本地存储（${detail}）${error.requestId ? ` | requestId=${error.requestId}` : ""}`);
      const local = await saveLocal(buffer, originalName, folder, kind);
      return { ...local, fallbackFrom: "cloudbase", fallbackError: error.message, fallbackCode: error.code || "" };
    }
  }
  return saveLocal(buffer, originalName, folder, kind);
}
