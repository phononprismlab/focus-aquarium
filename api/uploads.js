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
export const AUDIO_MIME = /^audio\//i;

function safeName(name) {
  const base = path.basename(String(name || "audio"));
  const ext = path.extname(base).toLowerCase();
  const stem = path.basename(base, ext)
    .replace(/[^\w一-龥.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "audio";
  return `${stem}${AUDIO_EXTENSIONS.includes(ext) ? ext : ".mp3"}`;
}

export function audioFileName(originalName) {
  const name = safeName(originalName);
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${stem}${ext}`;
}

export function ensureUploadDir() {
  fs.mkdirSync(path.join(UPLOAD_ROOT, "sounds"), { recursive: true });
  return UPLOAD_ROOT;
}

// 本地磁盘：Express 会把 /uploads 静态挂载到这个目录。
async function saveLocal(buffer, originalName) {
  ensureUploadDir();
  const fileName = audioFileName(originalName);
  const relative = `sounds/${fileName}`;
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
async function saveCloudbase(buffer, originalName) {
  const app = await getCloudbaseApp();
  const cloudPath = `sounds/${audioFileName(originalName)}`;
  const uploaded = await app.uploadFile({ cloudPath, fileContent: buffer });
  if (!uploaded || !uploaded.fileID) throw new Error("云存储上传未返回 fileID");
  return { fileID: uploaded.fileID, path: uploaded.fileID, cloudPath, url: "", driver: "cloudbase" };
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

export async function storeAudio({ buffer, originalName }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空");
  const driver = currentDriver();
  if (driver === "cloudbase") {
    try {
      return await saveCloudbase(buffer, originalName);
    } catch (error) {
      console.warn("云存储上传失败，已回落到本地存储：", error.message);
      const local = await saveLocal(buffer, originalName);
      return { ...local, fallbackFrom: "cloudbase", fallbackError: error.message };
    }
  }
  return saveLocal(buffer, originalName);
}
