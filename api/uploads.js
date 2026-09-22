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

// 云开发对象存储：配置 STORAGE_DRIVER=cloudbase 后启用，失败会自动回落到本地。
async function saveCloudbase(buffer, originalName) {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (!env) throw new Error("未配置 CLOUDBASE_ENV_ID，无法使用云存储");
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const credentials = process.env.CLOUDBASE_SECRETID && process.env.CLOUDBASE_SECRETKEY
    ? { secretId: process.env.CLOUDBASE_SECRETID, secretKey: process.env.CLOUDBASE_SECRETKEY }
    : {};
  const app = cloudbase.init({ env, ...credentials });
  const cloudPath = `sounds/${audioFileName(originalName)}`;
  const uploaded = await app.uploadFile({ cloudPath, fileContent: buffer });
  if (!uploaded || !uploaded.fileID) throw new Error("云存储上传未返回 fileID");
  const { fileList } = await app.getTempFileURL({ fileList: [{ fileID: uploaded.fileID, maxAge: 315360000 }] });
  const url = fileList && fileList[0] ? fileList[0].tempFileURL : "";
  if (!url) throw new Error("获取云存储访问链接失败");
  return { url, path: cloudPath, fileID: uploaded.fileID, driver: "cloudbase" };
}

export async function storeAudio({ buffer, originalName }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("文件内容为空");
  const driver = (process.env.STORAGE_DRIVER || "local").toLowerCase();
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
