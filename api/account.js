// 自定义登录：服务端签发票据，前端拿票据去 CloudBase 认证。
//
// 为什么要有这个文件：CloudBase 自定义登录的私钥只能放服务端，票据必须服务端签。
// 一旦配错（字段名不对、环境对不上、PEM 被换行/转义破坏、密钥被重新生成），
// 症状一律只是「登录失败」，从前端完全看不出是哪一环坏了。所以这里把所有可校验的
// 环节都做成**能单测的纯函数**，并在 /api/health 里把配置状态直接说清楚。
//
// ⚠️ 安全边界：谁拿到 uid 谁就能登进去（票据是 uid 的凭证）。
//   所以服务端生成的 uid 必须是高熵随机值，不可枚举；客户端传来的 uid 严格校验格式。
//   跨设备的「同步码」是另一套机制（在账号方案 v2 里），不在本文件范围内。
import crypto from "node:crypto";
import cloudbase from "@cloudbase/node-sdk";

export const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
// SDK 的 createTicket 直接读这三个字段，名字写错就是运行时报错。
const REQUIRED_FIELDS = ["private_key_id", "private_key", "env_id"];

// 🔴 CloudBase 对自定义登录 uid 有硬限制，超了 createTicket 直接抛
//    Invalid uid（这个报错完全看不出是长度问题，踩过）：
//      /^[a-zA-Z0-9_\-#@~=*(){}[\]:.,<>+]{4,32}$/     —— 见 @cloudbase/app/.../constants.ts
//    即：4–32 位，字符集里不含 / 和空格。下面的两个正则都必须落在它之内。
export const CLOUDBASE_UID_PATTERN = /^[a-zA-Z0-9_\-#@~=*(){}[\]:.,<>+]{4,32}$/;

// 服务端生成的 uid：前缀 + 28 位十六进制（112 位随机），总长 30 位 —— 留 2 位余量，
// 不顶到 32 的上限。112 位不可枚举，且能被下面的正则明确识别成"我们自己发的"。
export const GENERATED_UID_PATTERN = /^u_[0-9a-f]{28}$/;
// 客户端传来的 uid 也允许（已有账号要能登录），但必须过这一关。
// 比 CloudBase 的规则更严：只放行字母数字和下划线连字符，避免把奇怪的东西塞进票据。
export const CLIENT_UID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;

const DEFAULT_TICKET_TTL_SECONDS = 3600;
const MAX_TICKET_TTL_SECONDS = 24 * 3600;
const MIN_TICKET_TTL_SECONDS = 60;

export function ticketTtlSeconds() {
  const raw = Number(process.env.ACCOUNT_TICKET_TTL_SECONDS || DEFAULT_TICKET_TTL_SECONDS);
  if (!Number.isFinite(raw)) return DEFAULT_TICKET_TTL_SECONDS;
  return Math.min(MAX_TICKET_TTL_SECONDS, Math.max(MIN_TICKET_TTL_SECONDS, Math.floor(raw)));
}

// ===== 凭证解析（纯函数，可单测）=====
//
// 支持两种填法，因为控制台的环境变量输入框里粘多行 JSON 极易被破坏：
//   1) 原始 JSON（压成一行：{"private_key_id":"...","private_key":"...","env_id":"..."}）
//   2) base64（推荐 —— 只有一行，不含换行和引号，粘贴不会出问题）
// 判断方式：以 "{" 或 "[" 开头当成 JSON，否则尝试 base64 解码。
// ⚠️ 只看 "{" 是不够的：JSON 数组（粘贴错的情形）会被当成 base64 去解，
//    解出来是乱码，报错就变成"不是合法 JSON"，把真实问题（填了个数组）盖掉了。
export function parseCredentials(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error(`${CREDENTIALS_ENV} 未配置`);

  let json = text;
  if (!/^[\[{]/.test(json)) {
    try {
      const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
      if (!decoded.trim()) throw new Error("base64 解码结果为空");
      json = decoded;
    } catch (error) {
      throw new Error(`${CREDENTIALS_ENV} 既不是 JSON 也不是合法的 base64（${error.message}）`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${CREDENTIALS_ENV} 不是合法 JSON —— 常见原因是控制台粘贴时换行/引号被破坏，改用 base64 填`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CREDENTIALS_ENV} 解析结果不是对象`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`${CREDENTIALS_ENV} 缺少字段 ${field}（自定义登录私钥必须含 ${REQUIRED_FIELDS.join("、")}）`);
    }
  }
  return {
    credentials: {
      private_key_id: parsed.private_key_id,
      private_key: parsed.private_key,
      env_id: parsed.env_id
    },
    env: parsed.env_id,
    keyId: parsed.private_key_id
  };
}

// 凭证解析一次就够（每次签发都重新解析会在高并发下重复做 JSON/Base64 工作），
// 但必须能被测试重置 —— 否则改了环境变量的测试会读到上一个用例的缓存。
let cached = null;
let cachedError = null;

export function resetAccountCache() {
  cached = null;
  cachedError = null;
}

function resolveCredentials() {
  if (cached || cachedError) return { ok: Boolean(cached), value: cached, error: cachedError };
  try {
    cached = parseCredentials(process.env[CREDENTIALS_ENV]);
    cachedError = null;
    return { ok: true, value: cached, error: null };
  } catch (error) {
    cached = null;
    cachedError = error;
    return { ok: false, value: null, error };
  }
}

// ===== uid =====
export function generateUid() {
  return `u_${crypto.randomBytes(14).toString("hex")}`;
}

// 客户端能不能指定 uid：允许（已有账号要能登录），但必须过格式关。
// 空值走服务端生成，这是"首开自动建号"的路径。
export function normalizeUid(input) {
  const value = String(input == null ? "" : input).trim();
  if (!value) {
    const uid = generateUid();
    // 生成的 uid 也要过同一道格式关。否则以后改了生成规则（比如加长到 34 位），
    // 报错会是 createTicket 那句完全看不懂的 "Invalid uid"，而不是这里说清楚。
    if (!CLIENT_UID_PATTERN.test(uid)) return { error: `服务端生成的 uid 不合法：${uid}` };
    return { uid, generated: true };
  }
  if (!CLIENT_UID_PATTERN.test(value)) {
    return { error: "uid 只允许 4–32 位的字母、数字、下划线、连字符" };
  }
  return { uid: value, generated: false };
}

// ===== 签发 =====
export function issueTicket(uid) {
  const resolved = resolveCredentials();
  if (!resolved.ok) throw resolved.error;
  const { credentials, env, keyId } = resolved.value;
  const ttl = ticketTtlSeconds();
  let ticket;
  try {
    // createTicket 是纯本地 JWT 签名、不发网络请求，所以失败只可能是凭证本身坏了。
    const app = cloudbase.init({ env, credentials });
    ticket = app.auth().createTicket(uid, { refresh: ttl * 1000 });
  } catch (error) {
    // 报错里可能夹着 PEM 片段，统一换成人话，别把私钥内容吐给调用方。
    throw new Error(`签发票据失败：${error.message || "未知错误"}（通常是私钥被破坏或已失效）`);
  }
  if (typeof ticket !== "string" || !ticket) throw new Error("签发票据失败：SDK 返回空票据");
  return { ticket, uid, env, keyId, ttlSeconds: ttl };
}

// ===== /api/health 用：账号配置状态 =====
// 只暴露结构性事实，绝不输出私钥内容或完整票据。
export function accountStatus() {
  const resolved = resolveCredentials();
  if (!resolved.ok) {
    return {
      configured: false,
      error: resolved.error.message,
      envMatch: null,
      keyId: null
    };
  }
  const { env, keyId } = resolved.value;
  const targetEnv = String(process.env.CLOUDBASE_ENV_ID || "").trim();
  return {
    configured: true,
    envMatch: targetEnv ? env === targetEnv : null,
    // 私钥所属环境和部署环境对不上是最常见的一类错配，健康检查里直接说。
    ...(targetEnv && env !== targetEnv ? { mismatch: { keyEnv: env, targetEnv } } : {}),
    env,
    keyId,
    error: ""
  };
}

// ===== 限流 =====
// 票据等于登录凭证，接口不能变成"随便领"的水龙头。
// 这里是单实例内存计数：云托管多实例时不共享，所以只作为"挡住明显滥用"的一层，
// 真正的账号滥用防护靠后面的用户表与审计，不在最小闭环范围内。
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
// ⚠️ 阈值刻意放宽到 300/5 分钟：服务没有配置 trust proxy，云托管入口之后 req.ip
//    很可能是同一个入口 IP —— 按真实客户端计数的假设不成立，卡太紧会误伤正常用户。
//    所以这里只挡"明显在刷"的行为，真正的账号滥用防护靠后面的用户表与审计（账号方案 v2）。
const RATE_LIMIT_MAX = Math.max(1, Number(process.env.ACCOUNT_TICKET_RATE_LIMIT || 300));
const hits = new Map();

export function resetRateLimit() {
  hits.clear();
}

export function checkRateLimit(key) {
  const now = Date.now();
  const bucketKey = String(key || "unknown");
  const bucket = hits.get(bucketKey);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    hits.set(bucketKey, { start: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.start)) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX - bucket.count };
}

export const RATE_LIMIT = { windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX };
