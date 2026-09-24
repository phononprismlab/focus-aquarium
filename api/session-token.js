// 会话令牌：服务端自己签的 HMAC 令牌，用来在后续接口里证明「我是这个 uid」。
//
// 为什么需要它（而不是直接把 uid 放在请求里）：
//   uid 会出现在 localStorage、浏览器网络面板、用户截图、日志里。一旦它成为凭证，
//   拿到 uid 就等于拿到账号 —— 能读别人的鱼缸、能改别人的泡泡。而 uid 又必须是
//   长期存在的（前端每次打开都要用），没法像一次性令牌那样用完即弃。
//
// 为什么不用 CloudBase 的 access token：
//   验证它必须拿去 CloudBase 换 uid，每个请求一次网络往返 + 一次调用配额。
//   而存档接口是高频的（前端 debounce 推送），这条路会把调用次数吃光。
//   本地验签是零成本的，适合这个场景。
//
// 密钥从哪来：
//   优先读 FISHTANK_SESSION_SECRET；没配时**从 ADMIN_API_KEY 单向派生**。
//   派生而不是直接复用，是因为两者的泄露后果不该绑定：ADMIN_API_KEY 泄露意味着
//   「后台配置被改」，不该顺带把「所有玩家的存档」一起送出去。HMAC 是单向的，
//   拿到派生结果推不回管理密钥。
//   这样零配置即可用 —— 生产环境 ADMIN_API_KEY 必然存在（否则进程直接退出）。
import crypto from "node:crypto";

// 180 天。存档不是资金，泄露的后果是「别人能改你的鱼缸」，而不是资金损失。
// 之所以给这么长：自定义登录**没有「重新登录」这条路**，令牌一过期就等于让玩家重新建号、
// 存档全丢 —— 那个损失远大于多留半年的风险。而且前端每次打开都会静默续期，
// 活跃玩家的令牌实际上永远不会到期，180 天只是用来兜住「半年没玩又回来」的情况。
export const SESSION_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const SESSION_SECRET_ENV = "FISHTANK_SESSION_SECRET";
export const SESSION_TOKEN_HEADER = "authorization";

// 派生用的标签。换掉这个值等于让所有已发出的令牌立刻失效。
const DERIVE_LABEL = "fishtank-session-v1";

let cachedSecret;
let cachedSource = "";

// 测试用：改过环境变量之后必须清缓存，否则读到的是上一次的密钥。
export function resetSessionSecretCache() {
  cachedSecret = undefined;
  cachedSource = "";
}

// 返回 { secret, source }。source 取值：explicit（显式配置）/ derived（从管理密钥派生）/ none。
export function sessionSecretStatus(env = process.env) {
  if (cachedSecret !== undefined) return { secret: cachedSecret, source: cachedSource };
  const explicit = String(env[SESSION_SECRET_ENV] || "").trim();
  if (explicit) {
    cachedSecret = Buffer.from(explicit, "utf8");
    cachedSource = "explicit";
    return { secret: cachedSecret, source: cachedSource };
  }
  const adminKey = String(env.ADMIN_API_KEY || "").trim();
  if (adminKey) {
    cachedSecret = crypto.createHmac("sha256", DERIVE_LABEL).update(adminKey).digest();
    cachedSource = "derived";
    return { secret: cachedSecret, source: cachedSource };
  }
  // 两个都没有：本地裸跑（没配 ADMIN_API_KEY）时的状态。
  // 此时存档接口会返回 503 并说明原因，而不是静默地放行任何人。
  cachedSecret = null;
  cachedSource = "none";
  return { secret: null, source: cachedSource };
}

const b64url = value => Buffer.from(value).toString("base64url");
const sign = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest();

// 令牌格式：v1.<base64url(payload)>.<base64url(hmac)>
// 版本号放在最前面，将来换算法时可以并行接受两种格式，而不是一次性把所有人踢下线。
export function issueSessionToken(uid, { ttlMs = SESSION_TOKEN_TTL_MS, now = Date.now() } = {}) {
  const { secret } = sessionSecretStatus();
  if (!secret) return { error: "服务端未配置会话密钥（需要 ADMIN_API_KEY 或 FISHTANK_SESSION_SECRET）" };
  if (typeof uid !== "string" || !uid) return { error: "缺少用户标识" };
  const issuedAt = Number(now);
  const expiresAt = issuedAt + Number(ttlMs);
  const payload = { uid, iat: issuedAt, exp: expiresAt };
  const body = b64url(JSON.stringify(payload));
  const token = `v1.${body}.${b64url(sign(secret, body))}`;
  return { token, expiresAt, ttlSeconds: Math.floor(Number(ttlMs) / 1000) };
}

// 返回 { uid, expiresAt } 或 { error, expired? }。绝不抛异常 —— 调用方一律拿返回值判断。
export function verifySessionToken(token, { now = Date.now() } = {}) {
  const { secret } = sessionSecretStatus();
  if (!secret) return { error: "服务端未配置会话密钥" };
  if (typeof token !== "string" || !token.trim()) return { error: "缺少会话令牌" };

  const parts = token.trim().split(".");
  if (parts.length !== 3) return { error: "会话令牌格式不正确" };
  const [version, body, signature] = parts;
  if (version !== "v1") return { error: `不支持的会话令牌版本：${version}` };

  const expected = sign(secret, body);
  let given;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return { error: "会话令牌签名不可解析" };
  }
  // 长度不等时 timingSafeEqual 会直接抛异常，先挡掉。
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { error: "会话令牌校验失败，请重新登录" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { error: "会话令牌内容不可解析" };
  }
  if (!payload || typeof payload.uid !== "string" || !payload.uid) {
    return { error: "会话令牌缺少用户标识" };
  }
  if (!Number.isFinite(payload.exp)) return { error: "会话令牌缺少有效期" };
  if (payload.exp <= Number(now)) return { error: "登录已过期，请重新进入", expired: true };
  return { uid: payload.uid, expiresAt: payload.exp };
}

// 从请求里取 uid。支持两种带法，方便前端在不同场景下用：
//   Authorization: Bearer <token>   （标准做法，推荐）
//   x-fishtank-token: <token>       （避开某些代理对 Authorization 的处理）
// 令牌只放在请求头里，不接受查询参数 —— query string 会被完整写进访问日志。
export function readRequestUid(req, { now = Date.now() } = {}) {
  const header = String((req.get && req.get(SESSION_TOKEN_HEADER)) || "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  const token = bearer
    ? bearer[1].trim()
    : String((req.get && req.get("x-fishtank-token")) || "").trim();
  if (!token) return { error: "缺少会话令牌，请先完成登录", missing: true };
  return verifySessionToken(token, { now });
}
