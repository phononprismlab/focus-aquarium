import cors from "cors";
import express from "express";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import { createRepository } from "./repository.js";
import { UPLOAD_ROOT, MAX_UPLOAD_MB, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, storeAudio, ensureUploadDir, resolveAudioPaths, currentDriver } from "./uploads.js";
import { resolveAllowList, createOriginChecker } from "./cors.js";
import { validateStartRequest } from "./reward.js";
import { createFocusSessionStore } from "./focus-session.js";
import { validateAudioConfig } from "./audio-config.js";
import { resolveAdminApiKey, checkProductionConfig, warnWeakAdminKey } from "./runtime-guard.js";

const app = express();
const host = process.env.HOST || "0.0.0.0";
// 监听端口。
// 主端口 PORT 默认 8080（非特权端口）：容器以非 root（USER node）运行，
// 绑 1024 以下的特权端口在部分容器运行时或安全加固策略下会被内核拒绝（EACCES）。
// EXTRA_PORTS 再额外听一组端口，默认带上 80 —— 云托管控制台的「服务端口」
// 可能被固定成 80 且创建后不便修改，应用同时听两个端口，平台探针打哪个都能通。
// 端口配置确定后，把 EXTRA_PORTS 设成空串即可关掉。
// 改这些值时必须同步改云托管控制台的「服务端口」。
const primaryPort = Number(process.env.PORT || 8080);
const extraPorts = String(process.env.EXTRA_PORTS ?? "80")
  .split(",")
  .map(value => Number(value.trim()))
  .filter(value => Number.isInteger(value) && value > 0 && value <= 65535 && value !== primaryPort);
const listenPorts = [primaryPort, ...extraPorts];

// 云开发 SDK 内部偶发的异步错误不能把整个 API 进程带走，这里兜住并记日志。
process.on("unhandledRejection", error => {
  console.error("未处理的异步错误：", error && error.message ? error.message : error);
});
const cloudbaseSdkVersion = "3.10.0";
let repository;
let repositoryError;

const { origins: allowedOrigins, source: originsSource } = resolveAllowList();
const isOriginAllowed = createOriginChecker(allowedOrigins);
const allowAllOrigins = allowedOrigins.includes("*");
if (originsSource === "default") {
  console.warn("CORS_ORIGINS 未配置，正在使用内置兜底名单（含测试域名）。生产环境请显式配置 CORS_ORIGINS。");
} else if (allowAllOrigins) {
  console.warn("CORS_ORIGINS=*，所有来源都被放行。请确认这是有意为之。");
}

// 同一个地址对不同 Origin 会返回不同的响应头，中间的缓存必须按 Origin 区分，否则会串。
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    // 抛错会让 Express 返回 500，浏览器只能看到一个莫名的服务端错误；
    // 规范做法是干脆不发 CORS 响应头，让浏览器自己拦。
    console.warn(`CORS 已拒绝来源：${origin}`);
    return callback(null, false);
  },
  methods: ["GET", "HEAD", "PUT", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: "2mb" }));

// 已上传的音频走静态目录对外提供，不要求管理密钥。
// 上传目录建不出来不该让整个服务起不来：云存储模式下根本用不到本地目录，
// 只挂了只读文件系统时也应该能正常提供配置读取。
try {
  ensureUploadDir();
} catch (error) {
  console.warn(`上传目录不可用（${UPLOAD_ROOT}）：${error.message}。上传会失败，其余接口继续服务。`);
}
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
// When not set (e.g. local dev), admin routes remain open for convenience —
// 但生产环境不允许这种状态，下面会直接拒绝启动。
const adminApiKey = resolveAdminApiKey();
const requireAdminAuth = (req, res, next) => {
  if (!adminApiKey) return next();
  if (req.get("x-admin-key") === adminApiKey) return next();
  return res.status(401).json({ error: "未授权：请提供有效的管理密钥" });
};

// 生产环境漏配管理密钥是"谁都能改游戏配置"级别的风险，宁可起不来也不能带病上线。
// 放在建仓库之前：连数据库都不用连，直接退出。
const productionConfigError = checkProductionConfig({ nodeEnv: process.env.NODE_ENV, adminApiKey });
if (productionConfigError) {
  console.error(productionConfigError);
  process.exit(1);
}

const types = new Set(["decorations", "fish", "focus", "audio"]);
const singletonTypes = new Set(["focus", "audio"]);
const idFor = (type, data) => type === "fish" ? data.fishid : singletonTypes.has(type) ? type : data.id;
const validate = (type, data) => {
  if (!data || typeof data !== "object") return "请求体必须是对象";
  if (type === "decorations" && (!data.id || !data.category || !data.name)) return "商品必须包含 id、category、name";
  if (type === "fish" && (!data.fishid || !data.name)) return "鱼类必须包含 fishid、name";
  if (type === "focus" && (!Number.isFinite(Number(data.minFocusDuration)) || !Array.isArray(data.rewardTiers))) return "专注配置必须包含 minFocusDuration 和 rewardTiers";
  if (type === "audio") return validateAudioConfig(data);
  return null;
};
// 数据层状态单独存一个字段给 /api/health 读，而不是让健康检查去 await 仓库。
// 仓库初始化要连云开发 RDB 并串行补齐十几条种子数据，全程是网络往返；
// 健康检查一旦等它，容器编排就会在这段时间里一直探不通，把整个版本判成部署失败 ——
// 表现就是"启动日志里服务明明起来了，部署却失败"。
let repositoryStatus = "pending";
const repositoryReady = createRepository().then(instance => {
  repository = instance;
  repositoryStatus = "ok";
  console.log("Repository initialized");
  return instance;
}).catch(error => {
  repositoryError = error;
  repositoryStatus = "failed";
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

// 健康检查供容器编排使用：只回答"这个进程还活着吗"，永远立刻返回 200，不碰数据层。
// 数据层是外部依赖，慢或者不可用都不该让探针失败 —— 探针失败会被判成实例故障，
// 进而导致反复重启和"部署版本失败"，而这跟业务是否真的可用完全是两回事。
// 数据层状态读上面那个字段（pending / ok / failed），排查时看得到，但不影响探针结论。
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    storage: currentDriver(),
    repository: repositoryStatus,
    cors: allowAllOrigins ? "all" : (originsSource === "env" ? "configured" : "fallback"),
    adminAuth: adminApiKey ? "enabled" : "disabled"
  });
});

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

// 公开接口的字段里有 cloud:// 标识时，需要换成可播放 / 可显示的链接，
// 否则前端 <img src> / <audio src> 会拿到 cloud:// 直接 404。
// 音频和装点鱼缸商品都可能有此问题，统一在出库时解析。
const PUBLIC_PATH_RESOLVE_TYPES = new Set(["audio", "decorations"]);
for (const type of types) {
  app.get(`/api/admin/${type}`, async (req, res) => {
    try {
      const data = await records(type);
      // 云存储的 cloud:// 标识只对内使用，出库前换成可播放的临时链接。
      res.json({ data: PUBLIC_PATH_RESOLVE_TYPES.has(type) ? await resolveAudioPaths(data) : data });
    } catch (error) { sendError(res, error); }
  });
  app.get(`/api/game/${type}`, async (req, res) => {
    try {
      const published = await (await getRepository()).list(type, true);
      const mapped = published.map(record => ({ ...record, data: record.publishedData || record.data }));
      res.json({ data: PUBLIC_PATH_RESOLVE_TYPES.has(type) ? await resolveAudioPaths(mapped) : mapped });
    } catch (error) { sendError(res, error); }
  });
}

// ===== 专注会话与奖励结算 =====
// 服务端记录开始时间，结算时用自己记录的时间推算实际专注时长，
// 客户端无法凭空声明时长。会话存在内存里，进程重启即失效 —— 这是可接受的：
// 结算失败时客户端会回落到本地计算，保证离线也能玩。
const focusSessions = createFocusSessionStore();

async function getPublishedFocusConfig() {
  const published = await (await getRepository()).list("focus", true);
  const record = published[0];
  if (!record) return null;
  return record.publishedData || record.data;
}

app.post("/api/game/focus/start", async (req, res) => {
  try {
    const focusConfig = await getPublishedFocusConfig();
    if (!focusConfig) return res.status(503).json({ error: "专注配置不可用" });
    const errorMessage = validateStartRequest(req.body, focusConfig);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    res.status(201).json({ data: focusSessions.start(req.body) });
  } catch (error) { sendError(res, error); }
});

app.post("/api/game/focus/complete", async (req, res) => {
  try {
    const sessionId = req.body && req.body.sessionId;
    if (!sessionId || typeof sessionId !== "string") return res.status(400).json({ error: "缺少 sessionId" });
    const focusConfig = await getPublishedFocusConfig();
    if (!focusConfig) return res.status(503).json({ error: "专注配置不可用" });
    const settlement = focusSessions.settle(sessionId, focusConfig);
    if (!settlement) return res.status(404).json({ error: "专注会话不存在或已过期" });
    res.json({ data: settlement });
  } catch (error) { sendError(res, error); }
});

// 音频上传：必须注册在 /api/admin/:type 之前，否则会被当成配置类型吃掉。
const audioUpload = multer({
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

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      return callback(new Error(`只支持图片文件：${IMAGE_EXTENSIONS.join(" ")}`));
    }
    callback(null, true);
  }
});

const uploadSingle = (req, res, next) => audioUpload.single("file")(req, res, error => {
  if (!error) return next();
  const message = error.code === "LIMIT_FILE_SIZE"
    ? `文件超过 ${MAX_UPLOAD_MB}MB 限制`
    : (error.message || "上传失败");
  res.status(400).json({ error: message });
});

const uploadImageSingle = (req, res, next) => imageUpload.single("file")(req, res, error => {
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
        // fallbackError 非空 = 云存储失败了，现在这个 path 只是容器本地磁盘上的临时文件，
        // 实例重建即 404。后台据此拒绝把它写进配置。
        fallbackError: stored.fallbackError || "",
        fallbackCode: stored.fallbackCode || ""
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "上传失败" });
  }
});

// 商品预览图上传：旧代码里 previewUpload 根本没走后端，保存的只是本地文件名（必然 404），
// 所以后台"上传了"也看不到。这里走和音频一样的 cloudbase / 本地双驱动 + 失败兜底。
app.post("/api/admin/assets/image", uploadImageSingle, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "请选择要上传的图片文件" });
    const stored = await storeAudio({ buffer: req.file.buffer, originalName: req.file.originalname, kind: "image" }, "images");
    res.json({
      data: {
        url: stored.url || "",
        path: stored.path,
        driver: stored.driver,
        size: req.file.size,
        name: req.file.originalname,
        fallbackError: stored.fallbackError || "",
        fallbackCode: stored.fallbackCode || ""
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

// 启动自检：绑定成功之后，用回环地址和容器自己的网卡地址各打一次 /api/health，
// 把结果写进启动日志。存在的意义是把两种完全不同的"部署失败"区分开：
//   1) 应用根本没监听成功 —— 自检本身就是失败
//   2) 应用在正常监听，但平台的探针够不着 —— 自检成功，而平台仍报 connection refused
// 线上长期卡在第 2 种状态：启动日志说 listening，平台探针说 connection refused，
// 两边说法矛盾，只有平台日志时只能靠猜。自检失败不影响服务，仅记录。
async function selfCheck(server) {
  try {
    const address = server.address();
    if (!address || typeof address !== "object") {
      // address() 为 null 的语义就是"没有在监听"。真机上走到这里说明绑定其实没成功，
      // 所以把 listening 一起打出来，避免下次还要靠猜。
      console.log(`启动自检：监听地址异常（${String(address)}，server.listening=${server.listening}）`);
      return;
    }
    console.log(`启动自检：已绑定 ${address.address}:${address.port}（family ${address.family}）`);

    // 容器里真正要能通的是网卡地址（平台的探针打的就是它），回环地址只是对照。
    const candidates = ["127.0.0.1"];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
      }
    }

    for (const target of candidates) {
      const url = `http://${target}:${address.port}/api/health`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        console.log(`启动自检：${url} -> ${res.status}`);
      } catch (error) {
        const code = (error && error.cause && error.cause.code) || error.name || "unknown";
        console.log(`启动自检：${url} -> 失败（${code}）`);
      }
    }
  } catch (error) {
    console.log(`启动自检本身出错：${error && error.message ? error.message : error}`);
  }
}

// Express 5 的 app.listen 会把回调同时挂到 server 的 'error' 事件上：
//     server.once('error', done)
// 也就是说绑定失败时，这个回调会被当作错误回调调用，第一个参数是 error。
// 旧代码忽略了参数，于是绑定失败照样打印 "listening on port"，
// 而 server.address() 返回 null —— 真机日志里因此只有一句
// 「启动自检：监听地址异常（null）」，应用侧一行错误都没有，
// 平台那边只能看到 connection refused。三轮部署失败都卡在这个静默上。
// 现在每个端口各自报告结果，并且至少要有一个端口听上才算启动成功。
function startListening(listenPort) {
  const state = { failed: false };
  return new Promise(resolve => {
    const server = app.listen(listenPort, host, error => {
      if (error) {
        state.failed = true;
        const code = error.code || error.name || "unknown";
        console.error(`监听 ${host}:${listenPort} 失败（${code}）—— ${error.message}`);
        if (code === "EACCES") {
          console.error("  原因：当前用户无权绑定该端口。容器以非 root（USER node）运行，1024 以下的特权端口会被内核拒绝。");
        } else if (code === "EADDRINUSE") {
          console.error("  原因：该端口已被占用，容器里可能有别的进程先占了它。");
        }
        return resolve(false);
      }
      console.log(`Fishtank API listening on ${host}:${listenPort}`);
      void selfCheck(server);
      resolve(true);
    });

    // 运行期错误（accept 失败、句柄耗尽等）也要可见。
    // Express 用的是 once('error')，只消费第一次；不自己兜住的话，后续 error 会变成未捕获异常。
    // 绑定阶段的那一次已经由上面的回调报告过，这里跳过，避免同一件事打两遍。
    server.on("error", error => {
      if (state.failed) return;
      console.error(`HTTP 服务运行期错误（${error.code || error.name || "unknown"}）：${error.message}`);
    });
  });
}

const listening = await Promise.all(listenPorts.map(startListening));
if (!listening.some(Boolean)) {
  console.error(`所有端口都无法监听（${listenPorts.join(", ")}），进程退出。`);
  console.error("请核对云托管控制台的「服务端口」配置，以及容器内是否有其他进程占用该端口。");
  process.exit(1);
}
console.log(`CORS 来源（${originsSource === "env" ? "来自 CORS_ORIGINS" : "内置兜底名单"}）：${allowAllOrigins ? "*（全部放行）" : allowedOrigins.join(", ")}`);
console.log(`管理接口鉴权：${adminApiKey ? "已启用（x-admin-key）" : "未启用 —— 仅限本地开发，生产环境会拒绝启动"}`);
warnWeakAdminKey(adminApiKey);
