import cors from "cors";
import express from "express";
import path from "node:path";
import multer from "multer";
import { createRepository } from "./repository.js";
import { UPLOAD_ROOT, MAX_UPLOAD_MB, AUDIO_EXTENSIONS, storeAudio, ensureUploadDir, resolveAudioPaths, currentDriver } from "./uploads.js";

const app = express();
const port = Number(process.env.PORT || 80);

// 云开发 SDK 内部偶发的异步错误不能把整个 API 进程带走，这里兜住并记日志。
process.on("unhandledRejection", error => {
  console.error("未处理的异步错误：", error && error.message ? error.message : error);
});
const cloudbaseSdkVersion = "3.10.0";
let repository;
let repositoryError;

const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length ? configuredOrigins : [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "https://test-d0gpv0jya4925be19-1491495221.tcloudbaseapp.com",
  "https://focus-aquarium-test-d0gpv0jya4925be19.webapps.tcloudbase.com"
];
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS origin not allowed"));
  },
  methods: ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: "2mb" }));

// 已上传的音频走静态目录对外提供，不要求管理密钥。
ensureUploadDir();
app.use("/uploads", express.static(UPLOAD_ROOT, {
  fallthrough: false,
  setHeaders(res, filePath) {
    if (/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000");
      res.setHeader("Accept-Ranges", "bytes");
    }
  }
}));

// Admin API key authentication.
// When ADMIN_API_KEY is set, all /api/admin/* requests must include
// an "x-admin-key" header matching the configured value.
// When not set (e.g. local dev), admin routes remain open for convenience.
const adminApiKey = process.env.ADMIN_API_KEY || "";
const requireAdminAuth = (req, res, next) => {
  if (!adminApiKey) return next();
  if (req.get("x-admin-key") === adminApiKey) return next();
  return res.status(401).json({ error: "未授权：请提供有效的管理密钥" });
};

const types = new Set(["decorations", "fish", "focus", "audio"]);
const singletonTypes = new Set(["focus", "audio"]);
const idFor = (type, data) => type === "fish" ? data.fishid : singletonTypes.has(type) ? type : data.id;
const validate = (type, data) => {
  if (!data || typeof data !== "object") return "请求体必须是对象";
  if (type === "decorations" && (!data.id || !data.category || !data.name)) return "商品必须包含 id、category、name";
  if (type === "fish" && (!data.fishid || !data.name)) return "鱼类必须包含 fishid、name";
  if (type === "focus" && (!Number.isFinite(Number(data.minFocusDuration)) || !Array.isArray(data.rewardTiers))) return "专注配置必须包含 minFocusDuration 和 rewardTiers";
  if (type === "audio") {
    if (!data.categories || typeof data.categories !== "object") return "音频配置必须包含 categories";
    if (!Array.isArray(data.sounds)) return "音频配置必须包含 sounds 数组";
    for (const sound of data.sounds) {
      if (!sound.id || !sound.name || !sound.category) return "每个音效必须包含 id、name、category";
      if (!["bgm", "prompt", "sfx"].includes(sound.category)) return `音效分类无效：${sound.category}`;
      const volume = Number(sound.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) return `音效 ${sound.id} 的音量必须在 0-100 之间`;
    }
    for (const [key, category] of Object.entries(data.categories)) {
      const volume = Number(category?.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) return `分类 ${key} 的音量必须在 0-100 之间`;
    }
  }
  return null;
};
const repositoryReady = createRepository().then(instance => {
  repository = instance;
  console.log("Repository initialized");
  return instance;
}).catch(error => {
  repositoryError = error;
  console.error("Repository initialization failed", error);
  return null;
});
const getRepository = async () => {
  const instance = await repositoryReady;
  if (!instance) throw repositoryError || new Error("Repository is unavailable");
  return instance;
};
const records = async type => (await getRepository()).list(type, false);
const sendError = (res, error) => res.status(500).json({ error: error.message || "服务器错误" });

app.get("/api/health", (req, res) => res.json({ ok: true, storage: process.env.CLOUDBASE_ENV_ID ? "cloudbase" : "memory" }));

// CloudBase authentication diagnostic — only available in non-production.
if (process.env.NODE_ENV !== "production") {
  app.get("/api/debug/cloudbase-auth", async (req, res) => {
    const apiKey = process.env.CLOUDBASE_APIKEY || "";
    const result = {
      hasEnvId: Boolean(process.env.CLOUDBASE_ENV_ID),
      hasApiKey: Boolean(apiKey),
      sdkVersion: cloudbaseSdkVersion,
      databaseTest: { status: "ok" }
    };
    try {
      const { default: cloudbase } = await import("@cloudbase/js-sdk");
      const app = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID });
      await app.database()
        .collection(process.env.CLOUDBASE_COLLECTION || "fishtank_configs")
        .where({ type: "decorations" })
        .limit(1)
        .get();
    } catch (error) {
      const message = apiKey ? String(error?.message || "").replace(apiKey, "[REDACTED]") : String(error?.message || "");
      result.databaseTest = {
        status: "failed",
        code: error?.code,
        message: message.replace(/(authorization|token|secretid|secretkey|apikey)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      };
    }
    res.json(result);
  });
}

// All /api/admin/* routes require the admin API key (when configured).
app.use("/api/admin", requireAdminAuth);

for (const type of types) {
  app.get(`/api/admin/${type}`, async (req, res) => {
    try {
      const data = await records(type);
      // 云存储的 cloud:// 标识只对内使用，出库前换成可播放的临时链接。
      res.json({ data: type === "audio" ? await resolveAudioPaths(data) : data });
    } catch (error) { sendError(res, error); }
  });
  app.get(`/api/game/${type}`, async (req, res) => {
    try {
      const published = await (await getRepository()).list(type, true);
      const mapped = published.map(record => ({ ...record, data: record.publishedData || record.data }));
      res.json({ data: type === "audio" ? await resolveAudioPaths(mapped) : mapped });
    } catch (error) { sendError(res, error); }
  });
}

// 音频上传：必须注册在 /api/admin/:type 之前，否则会被当成配置类型吃掉。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      return callback(new Error(`只支持音频文件：${AUDIO_EXTENSIONS.join(" ")}`));
    }
    callback(null, true);
  }
});

const uploadSingle = (req, res, next) => upload.single("file")(req, res, error => {
  if (!error) return next();
  const message = error.code === "LIMIT_FILE_SIZE"
    ? `文件超过 ${MAX_UPLOAD_MB}MB 限制`
    : (error.message || "上传失败");
  res.status(400).json({ error: message });
});

app.post("/api/admin/assets", uploadSingle, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "请选择要上传的音频文件" });
    const stored = await storeAudio({ buffer: req.file.buffer, originalName: req.file.originalname });
    res.json({
      data: {
        // 云存储返回的是永久标识 fileID（cloud://...），链接在出库时换取；
        // 本地存储则直接给出可访问 URL。
        url: stored.url || "",
        path: stored.path,
        driver: stored.driver,
        size: req.file.size,
        name: req.file.originalname,
        fallbackError: stored.fallbackError || ""
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "上传失败" });
  }
});

app.put("/api/admin/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!types.has(type)) return res.status(404).json({ error: "未知配置类型" });
  const errorMessage = validate(type, req.body);
  if (errorMessage) return res.status(400).json({ error: errorMessage });
  if (idFor(type, req.body) !== id) return res.status(400).json({ error: "路径 id 与请求体 id 不一致" });
  try { res.json({ data: await (await getRepository()).save(type, id, req.body) }); } catch (error) { sendError(res, error); }
});

app.post("/api/admin/:type", async (req, res) => {
  const { type } = req.params;
  if (!types.has(type)) return res.status(404).json({ error: "未知配置类型" });
  const errorMessage = validate(type, req.body);
  if (errorMessage) return res.status(400).json({ error: errorMessage });
  const id = idFor(type, req.body);
  try { res.status(201).json({ data: await (await getRepository()).save(type, id, req.body) }); } catch (error) { sendError(res, error); }
});

app.delete("/api/admin/:type/:id", async (req, res) => {
  if (!types.has(req.params.type)) return res.status(404).json({ error: "未知配置类型" });
  try { await (await getRepository()).remove(req.params.type, req.params.id); res.status(204).end(); } catch (error) { sendError(res, error); }
});

app.post("/api/admin/:type/:id/publish", async (req, res) => {
  if (!types.has(req.params.type)) return res.status(404).json({ error: "未知配置类型" });
  try {
    const data = await (await getRepository()).publish(req.params.type, req.params.id);
    if (!data) return res.status(404).json({ error: "配置不存在" });
    res.json({ data });
  } catch (error) { sendError(res, error); }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Fishtank API listening on port ${port}`);
  if (process.env.NODE_ENV === "production" && !adminApiKey) {
    console.warn("WARNING: ADMIN_API_KEY is not set. Admin endpoints are unprotected in production.");
  }
});
