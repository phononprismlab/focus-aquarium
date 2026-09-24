// 自定义登录私钥自检（账号功能的前置验证）。
//
// 为什么需要它：CloudBase 自定义登录的私钥是从控制台下载的 JSON，只有服务端能用。
// 一旦配错（字段名不对、环境 ID 不匹配、PEM 被换行/转义破坏、密钥被重新生成导致旧的失效），
// 症状都只是「登录失败」，很难看出是哪一环。而 createTicket() 是**纯本地 JWT 签名、不发网络请求**，
// 所以可以在部署前就把这些坑全部排掉。
//
// 跑法（二选一）：
//   TCB_CUSTOM_LOGIN_KEY='<私钥 JSON 全文>' node test/verify-custom-login-key.mjs
//   node test/verify-custom-login-key.mjs "C:/path/to/tcb_custom_login_key(env).json"
//
// 安全：本脚本只输出结论与元信息，**绝不打印私钥内容，也不打印完整票据**（票据等于登录凭证）。
// 不需要任何环境变量也能跑；没配置私钥时以「跳过」结束（退出码 0），不会打断任何流水线。
import fs from "node:fs";
import crypto from "node:crypto";
import cloudbase from "@cloudbase/node-sdk";

let pass = 0;
let fail = 0;
let skipped = 0;
function chk(name, ok, detail = "") {
  const mark = ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL";
  console.log(`${mark} | ${name}${detail ? " = " + detail : ""}`);
  if (ok === "skip") skipped += 1;
  else if (ok) pass += 1;
  else fail += 1;
}

// ===== 1. 拿到私钥：环境变量优先，其次命令行给的路径 =====
const fileArg = process.argv[2];
let raw = process.env.TCB_CUSTOM_LOGIN_KEY || "";
let source = raw ? "环境变量 TCB_CUSTOM_LOGIN_KEY" : "";
if (!raw && fileArg) {
  if (!fs.existsSync(fileArg)) {
    console.log(`FAIL | 找不到私钥文件：${fileArg}`);
    process.exit(1);
  }
  raw = fs.readFileSync(fileArg, "utf8");
  source = `文件 ${fileArg}`;
}
if (!raw.trim()) {
  console.log("SKIP | 没有配置自定义登录私钥（TCB_CUSTOM_LOGIN_KEY 为空且未传文件路径）");
  console.log("     账号功能上线前必须配置：CloudBase 控制台 → 环境 → 登录授权 → 自定义登录 → 下载私钥");
  console.log("\n----");
  console.log(`custom-login-key: PASS=0 FAIL=0 SKIP=1`);
  process.exit(0);
}
console.log(`来源：${source}`);

// ===== 2. 格式：必须是 JSON，且字段名与 SDK 的 ICredentialsInfo 一致 =====
let credentials = null;
try {
  credentials = JSON.parse(raw);
  chk("私钥是合法 JSON", true);
} catch (error) {
  chk("私钥是合法 JSON", false, error.message);
}
if (!credentials || typeof credentials !== "object") {
  console.log("\n----");
  console.log(`custom-login-key: PASS=${pass} FAIL=${fail + 1}`);
  process.exit(1);
}
// SDK 的 createTicket 直接读这三个字段，名字写错就是运行时报错。
for (const field of ["private_key_id", "private_key", "env_id"]) {
  chk(`含字段 ${field}`, typeof credentials[field] === "string" && credentials[field].length > 0,
    typeof credentials[field] === "string" ? `${credentials[field].length} 字符` : typeof credentials[field]);
}
if (typeof credentials.private_key !== "string" || typeof credentials.env_id !== "string") {
  console.log("\n----");
  console.log(`custom-login-key: PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}

// ===== 3. 私钥本身能不能被解析（PEM 被破坏的话这里就炸）=====
let publicKey = null;
try {
  publicKey = crypto.createPublicKey(credentials.private_key);
  chk("私钥能被解析为 RSA 私钥", true, `${publicKey.asymmetricKeyType} / ${publicKey.asymmetricKeyDetails?.modulusLength || "?"} 位`);
} catch (error) {
  chk("私钥能被解析为 RSA 私钥", false, error.message);
}

// ===== 4. 环境 ID 是否与部署目标一致（错配是最高频的坑）=====
const keyEnv = credentials.env_id;
const targetEnv = process.env.CLOUDBASE_ENV_ID || "";
chk("私钥里的 env_id 非空", Boolean(keyEnv), keyEnv);
if (targetEnv) {
  chk("私钥环境与 CLOUDBASE_ENV_ID 一致", keyEnv === targetEnv, `私钥=${keyEnv} 目标=${targetEnv}`);
} else {
  chk("私钥环境与 CLOUDBASE_ENV_ID 一致", "skip", "未设置 CLOUDBASE_ENV_ID，跳过比对");
}

// ===== 5. 真正签一张票据（这一步是 SDK 的完整路径，纯本地）=====
let ticket = "";
const probeUid = "verify-probe-0001";
try {
  const app = cloudbase.init({ env: keyEnv, credentials });
  ticket = app.auth().createTicket(probeUid, { refresh: 3600 * 1000 });
  chk("createTicket() 签发成功", typeof ticket === "string" && ticket.length > 0, `${ticket.length} 字符`);
} catch (error) {
  chk("createTicket() 签发成功", false, error.message);
}

// ===== 6. 票据结构：SDK 的约定是 private_key_id + "/@@/" + JWT =====
if (ticket) {
  const parts = ticket.split("/@@/");
  chk("票据由「密钥 ID + /@@/ + JWT」两段组成", parts.length === 2, `段数=${parts.length}`);
  chk("票据前缀就是私钥里的 private_key_id", parts[0] === credentials.private_key_id);
  const token = parts[1] || "";
  const segments = token.split(".");
  chk("JWT 是三段式", segments.length === 3, `段数=${segments.length}`);

  let header = null;
  let payload = null;
  try {
    header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    chk("JWT 头部/载荷可解析", true);
  } catch (error) {
    chk("JWT 头部/载荷可解析", false, error.message);
  }

  if (header) chk("签名算法是 RS256", header.alg === "RS256", String(header.alg));
  if (payload) {
    chk("载荷里的 uid 就是传入的 customUserId", payload.uid === probeUid, String(payload.uid));
    chk("载荷里的 env 与环境 ID 一致", payload.env === keyEnv, String(payload.env));
    const ttlMinutes = Math.round((payload.exp - payload.iat) / 60000);
    // 票据本身只有 10 分钟有效期，靠 refresh 续期；这里只是把口径固定下来，防止以后被误读成「票据 7 天有效」。
    chk("票据有效期约 10 分钟（靠 refresh 续期）", ttlMinutes >= 9 && ttlMinutes <= 11, `${ttlMinutes} 分钟`);
    chk("载荷带 refresh（SDK 默认 1 小时）", Number.isFinite(payload.refresh), String(payload.refresh));
    chk("载荷带 expire（SDK 默认 7 天）", Number.isFinite(payload.expire), String(payload.expire));
  }

  // ===== 7. 用私钥导出的公钥验签 —— 证明这张票据真的能用，而不是「看起来像 JWT」=====
  if (publicKey && segments.length === 3) {
    const ok = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${segments[0]}.${segments[1]}`),
      publicKey,
      Buffer.from(segments[2], "base64url")
    );
    chk("RS256 验签通过（票据真的可被 CloudBase 接受）", ok === true);
  }
}

// ===== 8. uid 校验规则（SDK 会拦掉非法 uid，提前知道边界省得线上试）=====
// SDK 的正则是 /^[a-zA-Z0-9_\-#@~=*(){}[\]:.,<>+]{4,32}$/
// 注意：不含空格、中文、emoji，也不含 ! $ % ^ & / ? | \ ' " ; ` 这些看起来"很常见"的字符。
{
  const app = cloudbase.init({ env: keyEnv, credentials });
  const badCases = ["", " ", "abc", "x".repeat(33), "有中文", "has space", "emoji🫧", "a!b@c", "a/b\\c", "a'b\"c", "a;b`c", "a$b%c", "a^b&c", "a|b?c"];
  const accepted = [];
  for (const uid of badCases) {
    try {
      app.auth().createTicket(uid);
      accepted.push(JSON.stringify(uid).slice(0, 24));
    } catch (_) { /* 预期被拒 */ }
  }
  chk("非法 uid 会被 SDK 拦下（空/短于 4/超 32/空格/中文/emoji/特殊符号）", accepted.length === 0, accepted.join(", ") || `全部 ${badCases.length} 例被拒`);

  const legal = ["abcd", "user_1-2.3", "A".repeat(32), "a#b@c~d=e*f", "u(1){2}[3]:4,5<6>7+8"];
  const rejected = [];
  for (const uid of legal) {
    try { app.auth().createTicket(uid); } catch (error) { rejected.push(`${uid.slice(0, 14)}…:${error.message}`); }
  }
  chk("合法 uid（4–32 位、含允许的符号）能签发", rejected.length === 0, rejected.join("; ") || `全部 ${legal.length} 例通过`);
}

console.log("\n----");
console.log(`custom-login-key: PASS=${pass} FAIL=${fail}${skipped ? ` SKIP=${skipped}` : ""}`);
if (fail === 0) console.log("私钥可用，可以开始做账号功能。");
process.exit(fail === 0 ? 0 : 1);
