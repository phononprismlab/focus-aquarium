// 同步码：把「我是这个 uid」从一台设备转移到另一台设备的凭证。
// 用途是跨设备接管账号 —— 换手机、换电脑时不用从头开始。
//
// 为什么不直接把会话令牌给玩家抄：
//   会话令牌 180 天有效。它一旦被截图、被抄错发到群里、被日志记下来，
//   等于账号长期被人拿着。同步码只有 10 分钟，而且**只能用来换会话令牌**，
//   不能直接拿去调 /api/game/* —— 两种凭证的密钥是分开派生的（见下）。
//
// 为什么不存数据库：
//   码里自带 uid 与过期时间，服务端验签即可确认，不需要查表。
//   （代价：做不到「一次性」—— 10 分钟内同一串码可以换多次令牌。但码只出现在
//    生成它的那台设备屏幕上，且必须当面传递，风险可接受；真要收严就得建表存哈希，
//    users 表已经预留了 sync_code_hash 列。）
//
// 密钥从哪来：
//   从会话密钥**二次派生**（标签不同）。这样两种凭证不能互相通用 ——
//   拿到同步码不能当会话令牌用，反之亦然。会话密钥本身又是从 ADMIN_API_KEY 派生的，
//   所以依然是零配置。
import crypto from "node:crypto";
import { sessionSecretStatus } from "./session-token.js";

// 10 分钟。够玩家把码从手机抄到电脑（或复制粘贴过去），又不至于让一串
// 长期有效的凭证飘在外面。
export const SYNC_CODE_TTL_MS = 10 * 60 * 1000;

// 版本号放在码的最前面：将来换算法时可以并行接受两种格式，
// 而不是一次性把所有正在传码的玩家踢回「重新生成」。
const SYNC_VERSION = "s1";
// 换掉这个值等于让所有已发出的同步码立刻失效。
const DERIVE_LABEL = "fishtank-sync-v1";

let cachedKey;
let cachedSource = "";

// 测试用：改过环境变量之后必须清缓存，否则读到的是上一次的密钥。
export function resetSyncCodeKeyCache() {
  cachedKey = undefined;
  cachedSource = "";
}

// 返回 { key, source }。source 与会话密钥同源：explicit / derived / none。
function syncKeyStatus() {
  const { secret, source } = sessionSecretStatus();
  if (!secret) {
    cachedKey = null;
    cachedSource = "none";
    return { key: null, source: cachedSource };
  }
  if (cachedKey !== undefined && cachedSource === source) return { key: cachedKey, source };
  cachedKey = crypto.createHmac("sha256", DERIVE_LABEL).update(secret).digest();
  cachedSource = source;
  return { key: cachedKey, source };
}

export function syncCodeStatus() {
  const { source } = syncKeyStatus();
  return { configured: source !== "none", source };
}

const b64url = value => Buffer.from(value).toString("base64url");
const sign = (key, body) => crypto.createHmac("sha256", key).update(body).digest();

// 同步码格式：s1.<base64url(payload)>.<base64url(hmac)>
// 前缀用 s 而不是 v，是为了一眼能看出「这不是会话令牌」（v1.…），
// 排错时不必去解 payload 才知道手里拿的是哪种凭证。
export function issueSyncCode(uid, { ttlMs = SYNC_CODE_TTL_MS, now = Date.now() } = {}) {
  const { key } = syncKeyStatus();
  if (!key) return { error: "服务端未配置会话密钥（需要 ADMIN_API_KEY 或 FISHTANK_SESSION_SECRET）" };
  if (typeof uid !== "string" || !uid) return { error: "缺少用户标识" };
  const issuedAt = Number(now);
  const expiresAt = issuedAt + Number(ttlMs);
  const payload = { uid, iat: issuedAt, exp: expiresAt };
  const body = b64url(JSON.stringify(payload));
  const code = `${SYNC_VERSION}.${body}.${b64url(sign(key, body))}`;
  return { code, expiresAt, ttlSeconds: Math.floor(Number(ttlMs) / 1000) };
}

// 返回 { uid, expiresAt } 或 { error, expired? }。绝不抛异常 —— 调用方一律拿返回值判断。
export function verifySyncCode(code, { now = Date.now() } = {}) {
  const { key } = syncKeyStatus();
  if (!key) return { error: "服务端未配置会话密钥" };
  if (typeof code !== "string" || !code.trim()) return { error: "缺少同步码" };

  const parts = code.trim().split(".");
  if (parts.length !== 3) return { error: "同步码格式不正确" };
  const [version, body, signature] = parts;
  if (version !== SYNC_VERSION) {
    // 顺手挡掉把会话令牌当同步码用的情况（v1.…），给一句人话而不是验签失败。
    if (version === "v1") return { error: "这不是同步码（看起来是登录令牌）" };
    return { error: `不支持的同步码版本：${version}` };
  }

  const expected = sign(key, body);
  let given;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return { error: "同步码签名不可解析" };
  }
  // 长度不等时 timingSafeEqual 会直接抛异常，先挡掉。
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { error: "同步码不正确或已失效" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { error: "同步码内容不可解析" };
  }
  if (!payload || typeof payload.uid !== "string" || !payload.uid) {
    return { error: "同步码缺少用户标识" };
  }
  if (!Number.isFinite(payload.exp)) return { error: "同步码缺少有效期" };
  if (payload.exp <= Number(now)) return { error: "同步码已过期，请在原设备上重新生成一个", expired: true };
  return { uid: payload.uid, expiresAt: payload.exp };
}
