import cors from "cors";
import express from "express";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import multer from "multer";
import { createRepository } from "./repository.js";
import { UPLOAD_ROOT, MAX_UPLOAD_MB, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, storeAudio, ensureUploadDir, resolveAudioPaths, storagePlan, storageStatus, probeStorageGateway } from "./uploads.js";
import { resolveAllowList, createOriginChecker } from "./cors.js";
import { validateStartRequest } from "./reward.js";
import { createFocusSessionStore } from "./focus-session.js";
import { validateAudioConfig } from "./audio-config.js";
import { validateEventConfig } from "./event-config.js";
import { resolveAdminApiKey, checkProductionConfig, warnWeakAdminKey } from "./runtime-guard.js";
import { accountStatus, issueTicket, normalizeUid, checkRateLimit, resetAccountCache, resetRateLimit, RATE_LIMIT } from "./account.js";
import { readRequestUid, issueSessionToken, verifySessionToken, sessionSecretStatus } from "./session-token.js";
import { issueSyncCode, verifySyncCode } from "./sync-code.js";
import { createPlayerStore, mergeSaveForWrite, planPurchase, planSettlement, normalizeBubbles, normalizeNickname, ARCHIVE_VERSION } from "./player-store.js";

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
// 请求体上限（B11）。配置里塞 base64 图片很容易撞上这个限制，
// 而 Express 默认会返回一坨 HTML，后台只看到「请求失败」，不知道该干什么。
// 这里保持上限不变（配置本身就该是小 JSON），但把话说清楚：
// 图片有专门的 multipart 上传接口，走它就没有体积焦虑。
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "2mb";
app.use(express.json({ limit: JSON_BODY_LIMIT }));

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

const types = new Set(["decorations", "fish", "focus", "audio", "events"]);
const singletonTypes = new Set(["focus", "audio"]);
const idFor = (type, data) => type === "fish" ? data.fishid : singletonTypes.has(type) ? type : data.id;
const validate = (type, data) => {
  if (!data || typeof data !== "object") return "请求体必须是对象";
  if (type === "decorations" && (!data.id || !data.category || !data.name)) return "商品必须包含 id、category、name";
  if (type === "fish" && (!data.fishid || !data.name)) return "鱼类必须包含 fishid、name";
  if (type === "focus" && (!Number.isFinite(Number(data.minFocusDuration)) || !Array.isArray(data.rewardTiers))) return "专注配置必须包含 minFocusDuration 和 rewardTiers";
  if (type === "audio") return validateAudioConfig(data);
  // 事件是配置驱动的（不写代码），handler 必须在服务端白名单里，
  // 否则后台能配出一个玩家端根本不认识的事件 —— 那种错误只在线上才暴露。
  if (type === "events") return validateEventConfig(data);
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
let injectedRepository = null;
// 仅供测试：用内存仓库等替身替换，避免测试去连真实云环境（也不触发云仓库初始化）。
export function setRepositoryForTest(repo) { injectedRepository = repo; }
const getRepository = async () => {
  if (injectedRepository) return injectedRepository;
  const instance = await repositoryReady;
  if (!instance) throw repositoryError || new Error("Repository is unavailable");
  return instance;
};
const records = async type => (await getRepository()).list(type, false);
const sendError = (res, error) => res.status(500).json({ error: error.message || "服务器错误" });

// ===== 玩家数据层（账号 / 存档 / 专注记录）=====
// 与配置仓库分开初始化：配置仓库启动时要串行补齐十几条种子数据（网络往返），
// 玩家数据层只是取到一个 RDB 客户端对象（不发网络请求），两者互不阻塞。
let playerStore;
let playerStoreError;
let playerStoreStatus = "pending";
const playerStoreReady = createPlayerStore().then(instance => {
  playerStore = instance;
  playerStoreStatus = "ok";
  console.log(`Player store initialized (${instance.driver})`);
  return instance;
}).catch(error => {
  playerStoreError = error;
  playerStoreStatus = "failed";
  console.error("Player store initialization failed", error);
  return null;
});
let injectedPlayerStore = null;
// 仅供测试：注入内存实现，避免测试去连真实云环境。
export function setPlayerStoreForTest(store) { injectedPlayerStore = store; }
const getPlayerStore = async () => {
  if (injectedPlayerStore) return injectedPlayerStore;
  const instance = await playerStoreReady;
  if (!instance) throw playerStoreError || new Error("Player store is unavailable");
  return instance;
};

// 新账号的 cohort。灰度期所有注册都来自名单，所以默认 early；
// 公开发布时把 FISHTANK_COHORT 设成 public（或改成按日期切换）。
const cohortForNewUser = () => {
  const value = String(process.env.FISHTANK_COHORT || "").trim().toLowerCase();
  return value === "public" ? "public" : "early";
};

// 健康检查供容器编排使用：只回答"这个进程还活着吗"，永远立刻返回 200，不碰数据层。
// 数据层是外部依赖，慢或者不可用都不该让探针失败 —— 探针失败会被判成实例故障，
// 进而导致反复重启和"部署版本失败"，而这跟业务是否真的可用完全是两回事。
// 数据层状态读上面那个字段（pending / ok / failed），排查时看得到，但不影响探针结论。
app.get("/api/health", (req, res) => {
  const plan = storagePlan();
  res.json({
    ok: true,
    storage: plan.driver,
    // PG 模式与传统模式的上传通道完全不同，出问题时这一行能直接告诉你该查哪条路。
    storageMode: plan.driver === "cloudbase" ? plan.mode : "",
    storageBucket: plan.bucket,
    // 存储状态：密钥没权限这类问题以前只有真传一次才暴露，现在这里直接说。
    // 只读内存字段，不碰网络 —— 健康检查绝不能被外部依赖拖住。
    storageState: plan.driver === "cloudbase" ? storageStatus() : { upload: "unverified", gateway: "skipped" },
    // 配错的组合（生产走本地磁盘、缺 envId、pg 缺密钥）在这里显式列出来，别等上传失败才发现。
    storageProblems: plan.problems,
    repository: repositoryStatus,
    playerStore: playerStoreStatus,
    cors: allowAllOrigins ? "all" : (originsSource === "env" ? "configured" : "fallback"),
    adminAuth: adminApiKey ? "enabled" : "disabled",
    // 自定义登录私钥的配置状态。配错的表现一律只是"登录失败"，前端查不出是哪一环，
    // 所以把结构性事实（有没有配、环境和目标一不一致）直接放在健康检查里。
    // 只读缓存的解析结果，不发网络请求 —— 健康检查绝不能被外部依赖拖住。
    account: accountStatus(),
    // 会话令牌的密钥来源：explicit（显式配了 FISHTANK_SESSION_SECRET）
    // / derived（从 ADMIN_API_KEY 派生）/ none（都没配，存档接口会全部 401）。
    sessionKey: sessionSecretStatus().source
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
// 音频、装点鱼缸商品、鱼类资源都可能有此问题，统一在出库时解析。
// ⚠️ 新增需要解析的配置类型时，务必加进这个 Set：漏掉的话后台上传的资源
//    下发到玩家端会是裸 tcbpg:// 引用，图片/音频直接 404（B13 就是 fish 漏了这个）。
const PUBLIC_PATH_RESOLVE_TYPES = new Set(["audio", "decorations", "fish"]);

// 紧急总开关：设置 FISHTANK_DISABLE_CUSTOM_CODE=1 后，公开接口不再下发鱼的动画代码，
// 玩家端会回退到内置行为 —— 线上自定义动画代码出问题时的「一键刹车」。
const customCodeDisabled = () => {
  const value = String(process.env.FISHTANK_DISABLE_CUSTOM_CODE || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};
function stripCustomFishCode(record) {
  if (!customCodeDisabled() || !record || !record.data || !("animationCode" in record.data)) return record;
  const { animationCode, ...rest } = record.data;
  return { ...record, data: rest };
}

// 后台用户列表：按注册时间排序 + cohort 筛选 + 赞赏状态筛选。
// 聚合（专注时长/次数、鱼数）由数据层一次性算好，不触发 N+1。受 requireAdminAuth 保护。
app.get("/api/admin/users", async (req, res) => {
  try {
    const store = await getPlayerStore();
    const cohort = typeof req.query.cohort === "string" && req.query.cohort ? req.query.cohort : undefined;
    const raw = req.query.isSupporter;
    const isSupporter = raw === "" || raw === "true" || raw === "1"
      ? true
      : raw === "false" || raw === "0"
        ? false
        : undefined;
    const users = await store.listUsers({ cohort, isSupporter });
    res.json({ data: { users, count: users.length } });
  } catch (error) { sendError(res, error); }
});

// 埋点概览：四个事件各给 今日 / 最近 7 天 / 累计。受 requireAdminAuth 保护。
app.get("/api/admin/track/summary", async (req, res) => {
  try {
    const store = await getPlayerStore();
    const events = await store.trackSummary();
    res.json({ data: { events } });
  } catch (error) { sendError(res, error); }
});

// 全量存档导出：备份用。一次拉回 users + saves，在服务端打包成一个 JSON 下发。
//
// 为什么要有它：个人版**没有数据回档**，存档在库里被误删 / 实例故障就永久没了。
// 这份导出是唯一能把存档搬出数据库实例的通道 —— 配合本机定时脚本
// （workspace 里的 fa-save-backup.mjs）每天拉一次落到异地磁盘，才算真有备份。
// ⚠️ 只导白名单字段：sync_code_hash 是凭证类数据，不进备份文件（见 ARCHIVE_USER_FIELDS）。
app.get("/api/admin/saves/export", async (req, res) => {
  try {
    const store = await getPlayerStore();
    const archive = await store.exportArchive();
    res.json({
      data: {
        archiveVersion: ARCHIVE_VERSION,
        exportedAt: Date.now(),
        counts: { users: archive.users.length, saves: archive.saves.length },
        users: archive.users,
        saves: archive.saves
      }
    });
  } catch (error) { sendError(res, error); }
});

// 从备份恢复存档。**默认 dry-run** —— 不带 `mode:"apply"` 就只算差异、一个字都不写。
//
// 为什么默认 dry-run：这是唯一能反向覆盖玩家存档的接口。恢复错了（选错备份、选错用户）
// 会直接抹掉玩家的鱼缸，而且玩家端拿到的是「服务端更新的存档」→ 本地存档也会跟着被覆盖，
// 没有第二次机会。所以先看清楚要改什么，再决定改。
//
// `apply` 时一并返回 rollback（被覆盖掉的旧存档）：调用方必须存下来 —— 恢复错了能立刻
// 拿它反向恢复。create 没有旧值，不进 rollback。
app.post("/api/admin/saves/restore", async (req, res) => {
  try {
    const entries = req.body && Array.isArray(req.body.saves) ? req.body.saves : null;
    if (!entries) return res.status(400).json({ error: "缺少 saves 数组（恢复内容来自 /api/admin/saves/export 导出的文件）" });
    if (!entries.length) return res.status(400).json({ error: "saves 是空的，没有要恢复的内容" });
    const apply = req.body.mode === "apply";
    const store = await getPlayerStore();
    const { items, rollback } = await store.restoreSaves(entries, { dryRun: !apply });
    const counts = items.reduce((acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc; }, {});
    // 备份里有、但 users 表里没有的 uid：存档能恢复，但玩家档案是空的。
    // 刻意不自动建号 —— cohort / is_supporter 这类字段补错了比缺着更难查。
    // 上限 200：恢复几百个用户时没必要为了「提示」再跑几百次查询。
    const missingUsers = [];
    if (items.length <= 200) {
      for (const item of items) {
        if (item.action === "skipped") continue;
        if (!await store.getUser(item.userId)) missingUsers.push(item.userId);
      }
    }
    res.json({
      data: {
        mode: apply ? "apply" : "dry-run",
        applied: apply,
        archiveVersion: ARCHIVE_VERSION,
        counts,
        items,
        rollback,
        missingUsers
      }
    });
  } catch (error) { sendError(res, error); }
});

for (const type of types) {
  app.get(`/api/admin/${type}`, async (req, res) => {
    try {
      const data = await records(type);
      // 后台接口返回云存储的**持久化引用**（tcbpg:// / cloud://），不解析成临时签名链接：
      // 否则后台编辑并保存时会把 1 小时过期的签名 URL 永久写回配置（B1）。
      // 只有公开接口 /api/game/:type 才解析成可播放/可显示的链接。
      res.json({ data });
    } catch (error) { sendError(res, error); }
  });
  app.get(`/api/game/${type}`, async (req, res) => {
    try {
      const published = await (await getRepository()).list(type, true);
      let mapped = published.map(record => ({ ...record, data: record.publishedData || record.data }));
      if (PUBLIC_PATH_RESOLVE_TYPES.has(type)) mapped = await resolveAudioPaths(mapped);
      // 总开关打开时，鱼的动画代码不下发（玩家端回退内置行为）。
      if (type === "fish") mapped = mapped.map(stripCustomFishCode);
      res.json({ data: mapped });
    } catch (error) { sendError(res, error); }
  });
}

// ===== 账号：自定义登录票据签发 =====
//
// 最小闭环只有这一步：服务端用自定义登录私钥签一张票据，前端拿它去 CloudBase 认证。
// 用户表 / 云存档 / 同步码是后面的事（账号方案 v2），这里刻意不做。
//
// 🔴 安全边界：票据就是"以某个 uid 登录"的凭证，接口不能变成随便领的水龙头。
//    三道闸：① uid 格式严格校验 ② 不传 uid 时服务端生成高熵随机值（不可枚举）
//    ③ 按 IP 限流。跨设备的身份迁移靠同步码（v2），不是靠猜 uid。
app.post("/api/account/ticket", async (req, res) => {
  // 先限流再做别的：凭证解析失败也要算进配额，否则可以拿错误请求刷。
  const limiter = checkRateLimit(req.ip || "unknown");
  if (!limiter.allowed) {
    return res.status(429).json({
      error: `请求过于频繁，请 ${limiter.retryAfterSeconds} 秒后再试`
    });
  }

  // 没配私钥就说没配，不要伪装成 500 —— 那是"部署问题"不是"服务器坏了"。
  if (!accountStatus().configured) {
    return res.status(503).json({
      error: "账号功能未启用：服务端尚未配置自定义登录私钥",
      hint: `在云托管服务的环境变量里配置 ${"CLOUDBASE_CUSTOM_LOGIN_KEY"}，然后重新部署`
    });
  }

  // ===== 这一步决定「你是谁」—— 整条账号链上唯一的身份入口 =====
  // 三种情况，只有前两种能拿到票据：
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  let normalized;
  let generated = false;
  if (body.token !== undefined) {
    // ① 带会话令牌 = 续期，或在另一台设备上恢复登录态。只认令牌里的 uid。
    const verified = verifySessionToken(body.token);
    if (verified.error) {
      return res.status(401).json({ error: verified.error, expired: verified.expired === true });
    }
    normalized = normalizeUid(verified.uid);
  } else if (body.uid !== undefined && String(body.uid).trim()) {
    // ② 🔴 只给 uid、不给令牌 —— 这就是「凭知道 uid 去登别人的账号」。
    //    uid 会出现在 localStorage、浏览器网络面板、用户截图里，它**不是凭证**。
    //    这条路必须堵死，否则云存档等于没有门（这也正是同步码存在的意义）。
    return res.status(403).json({
      error: "缺少会话令牌：uid 不能单独作为登录凭证",
      hint: "首次建号请不要传 uid（服务端会生成一个）；恢复登录态请传 token。"
    });
  } else {
    // ③ 什么都不传 = 首次建号。服务端生成高熵随机 uid（不可枚举）。
    normalized = normalizeUid(undefined);
    generated = true;
  }
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  try {
    const issued = issueTicket(normalized.uid);
    const session = issueSessionToken(issued.uid);

    // 建号。失败**不阻断签发** —— 表还没建好、数据库抖动，都不该让玩家连登录都做不到；
    // 存档接口在第一次真正写入时会再试一次 ensureUser。
    let created = false;
    try {
      const result = await (await getPlayerStore()).ensureUser(issued.uid, { cohort: cohortForNewUser() });
      created = result.created === true;
    } catch (error) {
      console.warn(`建号失败（不影响登录，首次写存档时会重试）：${error.message}`);
    }

    res.json({
      data: {
        ticket: issued.ticket,
        uid: issued.uid,
        // ⚠️ 票据本身只有 10 分钟有效期（SDK 固定），拿到必须尽快去登录；
        //    下面的 ttlSeconds 是登录态的刷新时长，不是票据有效期。
        ticketValidSeconds: 600,
        sessionTtlSeconds: issued.ttlSeconds,
        generated,
        // 环境 ID 由服务端下发：前端 init SDK 必须知道它，写死在前端就会有两份
        // 配置要同步（换环境时前端静默登错环境）。服务端本来就知道，直接给。
        env: issued.env,
        // 会话令牌：后续所有 /api/game/* 接口靠它证明「我是这个 uid」。
        // 与票据的分工：票据交给 CloudBase SDK 换登录态（10 分钟一次性）；
        // 令牌是我们自己签的，用于 HTTP 接口（180 天，前端每次打开静默续期）。
        token: session.token || "",
        tokenExpiresAt: session.expiresAt || 0,
        created
      }
    });
  } catch (error) {
    // 签发失败基本都是私钥坏了/失效了，报错里可能夹着 PEM 片段，统一换成人话。
    res.status(500).json({ error: error.message || "签发票据失败" });
  }
});

// 用同步码接管账号：在另一台设备上继续玩同一个号。
//
// 🔴 这个接口**不需要身份** —— 来兑换的人此刻手上一个凭证都没有，同步码就是他
//    唯一的凭证。所以限流必须放在最前面，否则它就是一个随便撞的开放接口。
//
// 兑换成功 = 拿到该 uid 的会话令牌，之后与正常登录完全一样（不再需要走
// CloudBase 自定义登录：uid 和令牌服务端都直接给了，省掉 965KB 的 SDK）。
app.post("/api/account/sync/redeem", async (req, res) => {
  const limiter = checkRateLimit(req.ip || "unknown");
  if (!limiter.allowed) {
    return res.status(429).json({ error: `请求过于频繁，请 ${limiter.retryAfterSeconds} 秒后再试` });
  }

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const verified = verifySyncCode(body.code);
  if (verified.error) {
    // 410 = 过期。与「码不对」分开：过期要玩家回原设备重新生成，
    // 「不对」多半是复制漏了字符，两种提示完全不同。
    return res.status(verified.expired ? 410 : 400).json({ error: verified.error });
  }

  const session = issueSessionToken(verified.uid);
  if (session.error) {
    return res.status(503).json({ error: session.error });
  }

  // 建号。与 /account/ticket 一样：失败不阻断，存档接口首次写入时会重试。
  try {
    await (await getPlayerStore()).ensureUser(verified.uid, { cohort: cohortForNewUser() });
  } catch (error) {
    console.warn(`同步码兑换后建号失败（不影响使用）：${error.message}`);
  }

  res.json({
    data: {
      uid: verified.uid,
      token: session.token,
      tokenExpiresAt: session.expiresAt,
      // 旧设备的令牌**照样有效**：多端共用同一个账号。不踢下线是有意的 ——
      // 玩家可能只是想在手机上看看，不该顺手把电脑踢出去。
      previousDeviceStillValid: true
    }
  });
});

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

// 会员标记一律以**服务端存档**为准。
//
// 以前是直接采信客户端 body 里的 isMember（focus-sessions.start(req.body)），
// 而前端本来就把它当可写字段用（DEV 面板有「切换会员」，存档推送里也带着它）——
// 于是谎报一次 isMember 就能拿到会员档奖励：线上梯度 25min 是 1/2，
// 同样 25 分钟，25 泡泡变 50 泡泡，直接翻倍。
//
// 云存档那条路一直是服务端权威（player-store.js 的 mergeSave 会把客户端的 isMember 丢掉），
// 只有专注结算这条路漏了。V1.0 不卖会员，所以这里正常返回 false；
// 未登录 / 存档层不可用一律按非会员，绝不因为查不到就放行。
async function resolveServerMembership(auth) {
  if (!auth || auth.error) return false;
  try {
    const store = await getPlayerStore();
    const stored = await store.getSave(auth.uid);
    const player = stored && stored.data && stored.data.PlayerData;
    return Boolean(player && player.isMember === true);
  } catch (error) {
    console.warn(`读取会员标记失败，按非会员结算：${error.message}`);
    return false;
  }
}

app.post("/api/game/focus/start", async (req, res) => {
  try {
    const focusConfig = await getPublishedFocusConfig();
    if (!focusConfig) return res.status(503).json({ error: "专注配置不可用" });
    const errorMessage = validateStartRequest(req.body, focusConfig);
    if (errorMessage) return res.status(400).json({ error: errorMessage });

    // ⚠️ 只取 plannedMinutes；isMember 由服务端自己查（见上面的 resolveServerMembership）。
    const auth = readRequestUid(req);
    const isMember = await resolveServerMembership(auth);
    const session = focusSessions.start({
      plannedMinutes: (req.body || {}).plannedMinutes,
      isMember
    });

    // 会话同时在 focus_records 里落一行（未结算）。
    // ⚠️ **登录不是专注的前提** —— 未登录、离线都照常能专注，只是这条记录不进服务端统计。
    //    写库失败也只记日志：专注是核心动作，不能被数据库抖动挡住。
    if (!auth.error) {
      try {
        await (await getPlayerStore()).addFocusRecord({
          id: session.sessionId,
          user_id: auth.uid,
          planned_minutes: session.plannedMinutes,
          counted_minutes: 0,
          reward: 0,
          natural: false,
          started_at: session.startedAt,
          settled_at: 0
        });
      } catch (error) {
        console.warn(`专注会话落库失败（不影响专注）：${error.message}`);
      }
      // 埋点：开始专注。fire-and-forget，失败只记日志，绝不挡住专注主流程。
      (await getPlayerStore()).addTrackingEvent({ userId: auth.uid, event: "focus_start", at: Date.now() })
        .catch(error => console.warn(`埋点 focus_start 写入失败：${error.message}`));
    }

    res.status(201).json({ data: session });
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

    // 结算结果写回 focus_records，供后台统计与 /api/game/me 的累计时长使用。
    // ⚠️ 这里**不写存档泡泡**：V1.0 泡泡是客户端权威（见 player-store.js 的说明），
    //    前端自己落地奖励并随后 push 存档；两边都加会变成双倍奖励。
    const auth = readRequestUid(req);
    if (!auth.error) {
      try {
        const settled = await (await getPlayerStore()).settleFocusRecord(sessionId, {
          countedMinutes: settlement.countedMinutes,
          reward: settlement.reward,
          natural: settlement.naturalCompletion
        });
        // 防重放：同一会话重复结算不重复埋点（alreadySettled = 这次没真正落账）。
        if (settled && settled.alreadySettled === false) {
          (await getPlayerStore()).addTrackingEvent({ userId: auth.uid, event: "focus_complete", at: Date.now() })
            .catch(error => console.warn(`埋点 focus_complete 写入失败：${error.message}`));
        }
      } catch (error) {
        console.warn(`专注结算落库失败（不影响奖励发放）：${error.message}`);
      }
    }

    res.json({ data: settlement });
  } catch (error) { sendError(res, error); }
});

// ===== 埋点上报 =====
// 客户端只负责「打开」这一个事件 —— 开始/完成专注与购买由服务端在权威时机直接落库，
// 不接受客户端代报（客户端说"我买好了"不算数，服务端自己经手的事自己记）。
// 埋点是观测能力，写入失败对玩家不可见：前端 fire-and-forget，这里照常返回。
app.post("/api/game/track", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  const event = String((req.body && req.body.event) || "").trim();
  if (event !== "open") {
    return res.status(400).json({ error: `只接受 open 事件；${event || "(空)"} 由服务端自动记录，不需要也不会收客户端上报` });
  }
  try {
    await identity.store.addTrackingEvent({ userId: identity.uid, event, at: Date.now() });
    res.status(201).json({ data: { ok: true } });
  } catch (error) { sendError(res, error); }
});

// ===== 云存档 =====
//
// 三个接口都要身份：没有会话令牌一律 401。
// 存档层不可用时返回 503 + 原因 —— 前端据此回落到纯本地模式（最坏情况 = 现在的行为）。

// 身份 + 存档层就绪的公共前置，省得每个接口重复同样三行。
async function requireIdentity(req, res) {
  const auth = readRequestUid(req);
  if (auth.error) {
    res.status(401).json({ error: auth.error, expired: auth.expired === true });
    return null;
  }
  let store;
  try {
    store = await getPlayerStore();
  } catch (error) {
    res.status(503).json({ error: "云存档暂时不可用，本地进度不受影响", detail: error.message });
    return null;
  }
  return { uid: auth.uid, store };
}

// 拉存档。没有记录时返回 exists:false，而不是造一份空存档 ——
// 「服务端还没有你的数据」和「你的数据是空的」是两件事，前端要能区分（前者不该覆盖本地）。
app.get("/api/game/save", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const row = await identity.store.getSave(identity.uid);
    res.json({
      data: {
        exists: Boolean(row && row.data),
        save: row ? row.data : null,
        updatedAt: row ? row.updated_at : 0
      }
    });
  } catch (error) { sendError(res, error); }
});

// 推存档。字段分权在 mergeSaveForWrite 里，这里只负责取服务端现值再交给它合并。
app.put("/api/game/save", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const stored = await identity.store.getSave(identity.uid);
    const merged = mergeSaveForWrite(stored ? stored.data : null, req.body, {
      saveVersion: String((req.body && req.body.saveVersion) || "")
    });
    const clientTs = Number(req.body && req.body.clientTs);
    const row = await identity.store.putSave(identity.uid, merged.save, {
      saveVersion: merged.save.saveVersion,
      clientTs: Number.isFinite(clientTs) ? clientTs : Date.now()
    });
    res.json({
      data: {
        save: row.data,
        updatedAt: row.updated_at,
        // 服务端丢弃/修正了什么。不展示给玩家，只用于对账与排查。
        adjustments: merged.problems,
        firstPush: merged.firstPush
      }
    });
  } catch (error) { sendError(res, error); }
});

// 购买。价格与库存上限一律取**已发布的服务端配置**，客户端只能报 itemId ——
// 否则前端改个价格就能一块钱买走背景。
app.post("/api/game/shop/buy", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const itemId = String((req.body && req.body.itemId) || "").trim();
    if (!itemId) return res.status(400).json({ error: "缺少 itemId" });

    const published = await (await getRepository()).list("decorations", true);
    const record = published.find(r => r.id === itemId);
    if (!record) return res.status(404).json({ error: "商品不存在或已下架" });
    const item = record.publishedData || record.data;
    // V1.0 不卖会员，所以会员商品买不到。上线前必须把后台的 isMemberOnly 全关掉，
    // 否则这几件就是商店里永远买不了的死件（上线判据里专门有一条盯它）。
    if (item.isMemberOnly === true) {
      return res.status(403).json({ error: `「${item.name || itemId}」需要会员，当前版本暂未开放` });
    }

    const stored = await identity.store.getSave(identity.uid);
    if (!stored || !stored.data) {
      return res.status(409).json({ error: "还没有云存档，请先让本地存档同步一次再购买" });
    }

    const category = String(item.category || "");
    const ownedCount = Number((((stored.data.PlayerData || {}).inventory || {})[category] || {})[itemId] || 0);
    const plan = planPurchase({ save: stored.data, item, ownedCount });
    if (plan.error) {
      // 402 = 「泡泡不够」，前端据此把提示做成「还差 N」而不是通用错误。
      const status = plan.code === "INSUFFICIENT" ? 402 : 400;
      return res.status(status).json({ error: plan.error, code: plan.code, short: plan.short || 0 });
    }

    const row = await identity.store.putSave(identity.uid, plan.save, {
      saveVersion: plan.save.saveVersion,
      clientTs: Date.now()
    });
    // 埋点：购买成功（单件直购路径）。免费商品也算一次取得，paid 记在 detail 里。
    identity.store.addTrackingEvent({ userId: identity.uid, event: "purchase", detail: JSON.stringify({ itemId, paid: plan.paid }), at: Date.now() })
      .catch(error => console.warn(`埋点 purchase 写入失败：${error.message}`));
    res.json({
      data: { save: row.data, paid: plan.paid, balance: plan.balance, ownedCount: plan.ownedCount }
    });
  } catch (error) { sendError(res, error); }
});

// 批量结算：商店里「改完鱼缸点保存」的入口。
//
// 与 shop/buy 的分工：buy 是单件即时购买，settle 才是玩家实际会走的路径 ——
// 前端的商店允许自由调整鱼缸，一次保存可能同时买几条鱼、退还一个背景，必须原子完成。
// 客户端提交的是**目标鱼缸**（想要的最终状态），不是「买什么」；
// 差额由服务端拿它和上一次的鱼缸算，价格与上限全部以服务端配置为准。
app.post("/api/game/shop/settle", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const published = await (await getRepository()).list("decorations", true);
    const items = new Map(published.map(record => [record.id, record.publishedData || record.data]));

    const stored = await identity.store.getSave(identity.uid);
    if (!stored || !stored.data) {
      return res.status(409).json({ error: "还没有云存档，请先让本地存档同步一次再保存鱼缸" });
    }

    const plan = planSettlement({ save: stored.data, target: req.body, items });
    if (plan.error) {
      // 402 = 「泡泡不够」，前端据此显示「还差 N」；其余是配置/上限问题，按 400 处理。
      const status = plan.code === "INSUFFICIENT" ? 402 : 400;
      return res.status(status).json({
        error: plan.error,
        code: plan.code,
        short: plan.short || 0,
        paid: plan.paid || 0,
        refund: plan.refund || 0
      });
    }

    const row = await identity.store.putSave(identity.uid, plan.save, {
      saveVersion: plan.save.saveVersion,
      clientTs: Date.now()
    });
    // 埋点：购买成功（批量结算路径）。paid=0 的保存（只撤下/免费）不算购买。
    if (plan.paid > 0) {
      identity.store.addTrackingEvent({ userId: identity.uid, event: "purchase", detail: JSON.stringify({ paid: plan.paid, rows: (plan.rows || []).length }), at: Date.now() })
        .catch(error => console.warn(`埋点 purchase 写入失败：${error.message}`));
    }
    res.json({
      data: {
        save: row.data,
        paid: plan.paid,
        refund: plan.refund,
        total: plan.total,
        balance: plan.balance,
        // rows 是服务端算出来的收据明细，前端直接拿它渲染，不要用自己算的那份。
        rows: plan.rows
      }
    });
  } catch (error) { sendError(res, error); }
});

// 我的资料。同步码与跨设备切换留给 v2，这里先做只读。
app.get("/api/game/me", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  try {
    const [user, save, stats] = await Promise.all([
      identity.store.getUser(identity.uid),
      identity.store.getSave(identity.uid),
      identity.store.stats(identity.uid)
    ]);
    const data = (save && save.data) || {};
    res.json({
      data: {
        userId: identity.uid,
        nickname: (user && user.nickname) || "",
        cohort: (user && user.cohort) || "",
        createdAt: (user && user.created_at) || 0,
        isSupporter: Boolean(user && (user.is_supporter === true || user.is_supporter === 1)),
        bubbles: data.PlayerData ? normalizeBubbles(data.PlayerData.bubbles) : 0,
        fishCount: Array.isArray((data.AquariumData || {}).fish) ? data.AquariumData.fish.length : 0,
        ...stats
      }
    });
  } catch (error) { sendError(res, error); }
});

// ===== 用户档案：昵称 =====
// users.nickname 从建表起就空着，一直没有写入路径（后台列表因此全是「未命名」）。
// 这里开一个最小写入口：玩家侧能改的档案字段**只有昵称**，白名单和长度规则
// 都在 player-store（UPDATABLE_USER_FIELDS / normalizeNickname），路由层只做
// 身份、限频和回包。不做唯一性校验 —— 昵称不是登录凭证，重名无所谓。
const NICKNAME_WINDOW_MS = 60 * 1000;
const NICKNAME_MAX_PER_WINDOW = 6;
const nicknameHits = new Map();
function nicknameRateLimited(uid, at = Date.now()) {
  const hits = (nicknameHits.get(uid) || []).filter(t => at - t < NICKNAME_WINDOW_MS);
  if (hits.length >= NICKNAME_MAX_PER_WINDOW) { nicknameHits.set(uid, hits); return true; }
  hits.push(at);
  nicknameHits.set(uid, hits);
  // 兜底：进程活得久、uid 多时别让这张表无限长。
  if (nicknameHits.size > 5000) nicknameHits.clear();
  return false;
}

app.put("/api/game/me", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  if (nicknameRateLimited(identity.uid)) {
    return res.status(429).json({ error: "改得太频繁了，过一会儿再试" });
  }
  const parsed = normalizeNickname((req.body || {}).nickname);
  if (!parsed.ok) return res.status(400).json({ error: parsed.reason });
  try {
    // 建号兜底：票据签发时本该建好，但同步码接管等路径可能只拿到 uid 没有行。
    await identity.store.ensureUser(identity.uid);
    const user = await identity.store.updateUser(identity.uid, { nickname: parsed.value });
    if (!user) return res.status(503).json({ error: "档案暂时不可用，请稍后再试" });
    res.json({ data: { userId: identity.uid, nickname: user.nickname || "" } });
  } catch (error) { sendError(res, error); }
});

// ===== 跨设备同步码 =====
// 一台设备生成码，另一台设备输入码就能接管同一个账号（换手机/换电脑不用从头玩）。
// 生成码要身份（得先有自己的账号）；兑换码不要身份 —— 见 /api/account/sync/redeem。
app.post("/api/game/sync/code", async (req, res) => {
  const identity = await requireIdentity(req, res);
  if (!identity) return;
  const issued = issueSyncCode(identity.uid);
  // 走到这里只可能是没配会话密钥 —— 那是部署问题，说清楚而不是报 500。
  if (issued.error) return res.status(503).json({ error: issued.error });
  res.json({
    data: {
      code: issued.code,
      expiresAt: issued.expiresAt,
      ttlSeconds: issued.ttlSeconds,
      hint: `把这串码复制到另一台设备上，${issued.ttlSeconds / 60} 分钟内有效`
    }
  });
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
    const stored = await storeAudio({ buffer: req.file.buffer, originalName: req.file.originalname, mimeType: req.file.mimetype });
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
    const stored = await storeAudio({ buffer: req.file.buffer, originalName: req.file.originalname, kind: "image", mimeType: req.file.mimetype }, "images");
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

// 兜底错误处理（B11）。必须注册在所有路由之后。
// express.json 抛出的两类错误在默认处理器里会变成一坨 HTML，后台拿到的是
// 「请求失败」四个字，完全不知道是体积问题还是 JSON 写坏了：
//   · entity.too.large   → 413，多半是有人把图片转成 base64 塞进了配置
//   · entity.parse.failed→ 400，JSON 语法错误
// 这里把它们翻成人话。其它错误照旧记日志 + 500。
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error && (error.type === "entity.too.large" || error.status === 413 || error.statusCode === 413)) {
    return res.status(413).json({
      error: `请求体超过上限（${JSON_BODY_LIMIT}）。图片请不要以 base64 塞进配置，` +
        `改用后台的「上传图片」按钮（走 /api/admin/assets/image，单文件上限 ${MAX_UPLOAD_MB}MB）。`
    });
  }
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求体不是合法 JSON，请检查语法。" });
  }
  // /uploads 静态目录用 fallthrough:false，缺文件时会 next 一个 404 错误过来。
  // 这里必须保留原状态码，否则一次「图片不存在」会变成 500，误导排查方向。
  const status = Number((error && (error.status || error.statusCode)) || 0);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 404 ? "资源不存在" : ((error && error.message) || "请求失败") });
  }
  console.error("未处理的请求错误：", error && error.message ? error.message : error);
  return res.status(500).json({ error: "服务器错误" });
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

// 把"启动监听 + 打印启动信息"收敛成函数：便于测试显式调用，也便于直接 `node server.js` 时自动启动。
// 直接运行（node server.js）才自动监听；被 import（如测试）时不自动监听，交给测试去 call startServer()。
export async function startServer() {
  const listening = await Promise.all(listenPorts.map(startListening));
  if (!listening.some(Boolean)) {
    console.error(`所有端口都无法监听（${listenPorts.join(", ")}），进程退出。`);
    console.error("请核对云托管控制台的「服务端口」配置，以及容器内是否有其他进程占用该端口。");
    process.exit(1);
  }
  console.log(`CORS 来源（${originsSource === "env" ? "来自 CORS_ORIGINS" : "内置兜底名单"}）：${allowAllOrigins ? "*（全部放行）" : allowedOrigins.join(", ")}`);
  console.log(`管理接口鉴权：${adminApiKey ? "已启用（x-admin-key）" : "未启用 —— 仅限本地开发，生产环境会拒绝启动"}`);
  // 上传出问题时，第一眼看的就是这几行：模式选错（PG 环境用 classic 通道）会导致上传必然失败，
  // 而报错跟 RLS、密钥权限全都无关，极难从现象倒推。
  // 配错的组合（B9）在这里主动说出来，不要等上传失败才发现。
  const plan = storagePlan();
  if (plan.driver === "cloudbase") {
    console.log(plan.mode === "pg"
      ? `云存储：PG 模式，桶 ${plan.bucket}（经由 Storage API 网关，需 CLOUDBASE_APIKEY）`
      : "云存储：传统模式（getUploadMetadata + 直传 COS）");
  } else {
    console.log("云存储：未启用（上传写容器本地磁盘 /uploads）");
  }
  for (const problem of plan.problems) console.error(`存储配置有问题：${problem}`);
  // 网关可达性探测：fire-and-forget，只记录、不阻塞启动（探针打不通也不该影响服务起来）。
  void probeStorageGateway();
  warnWeakAdminKey(adminApiKey);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) startServer();
