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

export async function resolveCloudUrl(fileID) {
  const cached = urlCache.get(fileID);
  if (cached && cached.expire > Date.now()) return cached.url;
  if ((failedCache.get(fileID) || 0) > Date.now()) throw new Error("云存储链接暂不可用");
  const app = await getCloudbaseApp();
  try {
    const { fileList } = await app.getTempFileURL({ fileList: [{ fileID, maxAge: 3600 }] });
    const url = fileList && fileList[0] ? fileList[0].tempFileURL : "";
    if (!url) throw new Error("获取云存储访问链接失败");
    urlCache.set(fileID, { url, expire: Date.now() + URL_TTL_MS });
    failedCache.delete(fileID);
    return url;
  } catch (error) {
    failedCache.set(fileID, Date.now() + FAILED_TTL_MS);
    throw new Error(messageOf(error));
  }
}

// 把配置里的 cloud:// 标识换成可播放的链接，其它值原样返回。
export async function resolveAudioPaths(value) {
  if (typeof value === "string") {
    if (!value.startsWith("cloud://")) return value;
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
export async function storeAudio({ buffer, originalName, kind = "audio" }, folder = "sounds") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空");
  const driver = currentDriver();
  if (driver === "cloudbase") {
    try {
      return await saveCloudbase(buffer, originalName, folder, kind);
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
