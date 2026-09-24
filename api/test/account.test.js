// 账号最小闭环（服务端签发自定义登录票据）的回归测试。
//
// 三条主线：
// 1) 私钥解析必须同时支持「单行 JSON」和「base64」—— 控制台输入框里粘多行 JSON 必坏，
//    而配坏的后果一律只是"登录失败"，前端完全看不出是哪一环。
// 2) uid 必须落在 CloudBase 的硬限制内（/^[a-zA-Z0-9_\-#@~=*(){}[\]:.,<>+]{4,32}$/）。
//    ⚠️ 踩过：一开始生成 34 位的 uid，createTicket 直接抛 "Invalid uid"，
//    这个报错完全看不出是长度问题。所以这里锁死"生成的 uid 必须过 CloudBase 的正则"。
// 3) 接口不能被当成随便领登录凭证的水龙头 —— uid 格式、限流、未配置时明确 503。
//
// 全程自造 RSA 私钥：createTicket 是纯本地签名，不需要真私钥就能验票据结构，
// 所以这套测试在没有密钥的机器上也是全绿的（不会 SKIP）。
// 运行：node test/account.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}
function chkTrue(name, condition, detail = "") {
  const ok = condition === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}

// 自造一份"长得像控制台下载的私钥"的凭证，用于跑完整签发路径。
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const KEY_ID = "self-test-key-id-0001";
const KEY_ENV = "self-test-env-0001";
function makeCredentials(overrides = {}) {
  return { private_key_id: KEY_ID, private_key: privateKey, env_id: KEY_ENV, ...overrides };
}
const toBase64 = obj => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

const account = await import("../account.js");
const {
  parseCredentials, generateUid, normalizeUid, issueTicket, accountStatus,
  checkRateLimit, resetRateLimit, resetAccountCache,
  GENERATED_UID_PATTERN, CLIENT_UID_PATTERN, CLOUDBASE_UID_PATTERN, CREDENTIALS_ENV, RATE_LIMIT
} = account;

// 每个用例都重置：凭证解析结果是被缓存的，不重置就会读到上一个用例的值。
const withCredentials = (raw, fn) => {
  const previous = process.env[CREDENTIALS_ENV];
  process.env[CREDENTIALS_ENV] = raw;
  resetAccountCache();
  try { return fn(); } finally {
    if (previous === undefined) delete process.env[CREDENTIALS_ENV];
    else process.env[CREDENTIALS_ENV] = previous;
    resetAccountCache();
  }
};

// ⚠️ 解析/签发失败必须变成 FAIL，不能让整个测试文件崩掉 —— 崩掉会把后面所有断言都盖住，
//    反向验证（把每道闸退回原形）时就什么都看不到了。这里统一包一层。
function tryParse(raw) {
  try { return { ok: true, value: parseCredentials(raw) }; }
  catch (error) { return { ok: false, error: error.message }; }
}
function tryIssue(uid) {
  try { return { ok: true, value: issueTicket(uid) }; }
  catch (error) { return { ok: false, error: error.message }; }
}

// ===== 1. 私钥解析 =====
console.log("--- 1. 私钥解析：单行 JSON 与 base64 都要能读 ---");
{
  const parsed = tryParse(JSON.stringify(makeCredentials()));
  chk("单行 JSON 能解析出 env", parsed.ok ? parsed.value.env : parsed.error, KEY_ENV);
  chk("单行 JSON 能解析出 keyId", parsed.ok ? parsed.value.keyId : parsed.error, KEY_ID);
  chkTrue("解析结果只含 SDK 要的三个字段", parsed.ok && JSON.stringify(Object.keys(parsed.value.credentials).sort()) === JSON.stringify(["env_id", "private_key", "private_key_id"]));
}
{
  const parsed = tryParse(toBase64(makeCredentials()));
  chk("base64 能解析出 env", parsed.ok ? parsed.value.env : parsed.error, KEY_ENV);
}
{
  const parsed = tryParse(Buffer.from(JSON.stringify(makeCredentials()), "utf8").toString("base64").replace(/(.{40})/g, "$1\n"));
  chk("base64 里混了换行也能解析（控制台粘贴常态）", parsed.ok ? parsed.value.env : parsed.error, KEY_ENV);
}
for (const [name, raw] of [["空字符串", ""], ["纯空白", "   "], ["未定义", undefined]]) {
  let message = "";
  try { parseCredentials(raw); } catch (error) { message = error.message; }
  chkTrue(`${name} → 报「未配置」`, message.includes("未配置"), message);
}
{
  let message = "";
  try { parseCredentials("这不是JSON也不是base64!!!"); } catch (error) { message = error.message; }
  chkTrue("既不是 JSON 也不是 base64 → 报错里说清两种填法", message.includes("JSON") && message.includes("base64"), message);
}
for (const field of ["private_key_id", "private_key", "env_id"]) {
  const broken = makeCredentials();
  delete broken[field];
  let message = "";
  try { parseCredentials(JSON.stringify(broken)); } catch (error) { message = error.message; }
  chkTrue(`缺字段 ${field} → 报错指明是哪个字段`, message.includes(field), message);
}
for (const [name, raw] of [["裸数组", "[1,2,3]"], ["base64 编码的数组", Buffer.from("[1,2,3]", "utf8").toString("base64")]]) {
  let message = "";
  try { parseCredentials(raw); } catch (error) { message = error.message; }
  chkTrue(`${name} → 报「不是对象」而不是被误判成非法 JSON`, message.includes("不是对象"), message);
}

// ===== 2. uid：必须落在 CloudBase 的硬限制内 =====
console.log("\n--- 2. uid：长度与字符集必须过 CloudBase 的硬规则 ---");
{
  const uid = generateUid();
  chkTrue("生成的 uid 匹配我们的格式", GENERATED_UID_PATTERN.test(uid), uid);
  // 🔴 这条是踩过坑的回归：34 位的 uid 会被 createTicket 拒，且报错看不出是长度问题。
  chkTrue("生成的 uid 匹配 CloudBase 的 4–32 位硬规则", CLOUDBASE_UID_PATTERN.test(uid), `长度=${uid.length}`);
  chkTrue("生成的 uid 不超过 32 位", uid.length <= 32, `${uid.length} 位`);
  chkTrue("两次生成的 uid 不同", generateUid() !== generateUid());
}
{
  const n = normalizeUid("");
  chkTrue("不传 uid → 自动生成", n.generated === true && GENERATED_UID_PATTERN.test(n.uid), n.uid);
  chkTrue("自动生成时没有 error", !n.error);
}
{
  const n = normalizeUid("dominik-phone-01");
  chk("传入合法 uid → 原样使用", [n.uid, n.generated], ["dominik-phone-01", false]);
}
for (const [name, bad] of [
  ["含斜杠", "bad/uid"],
  ["含空格", "bad uid"],
  ["太短（3 位）", "abc"],
  ["太长（33 位）", "a".repeat(33)],
  ["含中文", "用户001"],
  ["对象", { toString: () => "[object Object]" }]
]) {
  const n = normalizeUid(bad);
  chkTrue(`${name} → 报格式错误`, Boolean(n.error), n.error || "竟然通过了");
}
chkTrue("生成的 uid 也在客户端格式允许范围内（两条规则不冲突）", CLIENT_UID_PATTERN.test(generateUid()));

// ===== 3. 签发与票据结构 =====
console.log("\n--- 3. 票据：结构必须是「密钥 ID + /@@/ + JWT」 ---");
withCredentials(toBase64(makeCredentials()), () => {
  const uid = generateUid();
  const issued = tryIssue(uid);
  chk("签发不报错", issued.ok ? "" : issued.error, "");
  // 下面全部走 issued.value：签发失败时就地变红，而不是抛异常把后面的断言全盖掉。
  const ticket = issued.ok ? String(issued.value.ticket || "") : "";
  chk("签发的 uid 与传入一致", issued.ok ? issued.value.uid : null, uid);
  chk("票据 TTL 是秒数", issued.ok ? issued.value.ttlSeconds : null, 3600);
  const parts = ticket.split("/@@/");
  chk("票据由两段组成", parts.length, 2);
  chk("第一段是私钥的 private_key_id", parts[0] || null, KEY_ID);
  const segments = parts[1] ? parts[1].split(".") : [];
  chk("第二段是三段式 JWT", segments.length, 3);
  const payload = segments[1] ? JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) : {};
  chk("JWT 里的 uid 与请求一致", payload.uid || null, uid);
  chk("JWT 里的 env 与私钥环境一致", payload.env || null, KEY_ENV);
  chkTrue("JWT 有过期时间", typeof payload.exp === "number" && payload.exp > payload.iat);
});
withCredentials("", () => {
  let message = "";
  try { issueTicket(generateUid()); } catch (error) { message = error.message; }
  chkTrue("没配私钥时签发会抛错（不会静默返回空票据）", message.includes("未配置"), message);
});

// ===== 4. accountStatus：给 /api/health 用，绝不泄漏私钥 =====
console.log("\n--- 4. 健康状态：配没配、环境对不对，直接说清 ---");
withCredentials(toBase64(makeCredentials()), () => {
  process.env.CLOUDBASE_ENV_ID = KEY_ENV;
  resetAccountCache();
  chk("已配置", accountStatus().configured, true);
  chk("环境一致", accountStatus().envMatch, true);
  chkTrue("不匹配时没有多余字段", !("mismatch" in accountStatus()));

  process.env.CLOUDBASE_ENV_ID = "another-env";
  resetAccountCache();
  const mismatched = accountStatus();
  chk("环境不一致 → envMatch=false", mismatched.envMatch, false);
  chk("环境不一致 → 给出双方环境名", mismatched.mismatch, { keyEnv: KEY_ENV, targetEnv: "another-env" });

  delete process.env.CLOUDBASE_ENV_ID;
  resetAccountCache();
  chk("没配目标环境 → envMatch 为 null（不该瞎报）", accountStatus().envMatch, null);
});
withCredentials("", () => {
  const status = accountStatus();
  chk("未配置 → configured=false", status.configured, false);
  chkTrue("未配置 → 带可读原因", status.error.includes("未配置"), status.error);
});
withCredentials(toBase64(makeCredentials()), () => {
  const dumped = JSON.stringify(accountStatus());
  chkTrue("健康状态里不含私钥内容", !dumped.includes("BEGIN") && !dumped.includes("PRIVATE KEY"));
});

// ===== 5. 限流（纯函数）=====
console.log("\n--- 5. 限流：接口不能变成随便领凭证的水龙头 ---");
{
  resetRateLimit();
  chkTrue("默认阈值足够宽松（入口 IP 可能是共享的）", RATE_LIMIT.max >= 100, `${RATE_LIMIT.max} 次 / ${RATE_LIMIT.windowMs / 60000} 分钟`);
  const first = checkRateLimit("1.2.3.4");
  chk("首次请求放行", first.allowed, true);
  chkTrue("放行时给出剩余次数", typeof first.remaining === "number" && first.remaining > 0);
  let blocked = null;
  for (let i = 0; i < RATE_LIMIT.max + 5 && !blocked; i++) {
    const r = checkRateLimit("1.2.3.4");
    if (!r.allowed) blocked = r;
  }
  chkTrue("超过阈值会被拦", Boolean(blocked));
  chkTrue("拦截时给出重试秒数", blocked && typeof blocked.retryAfterSeconds === "number" && blocked.retryAfterSeconds > 0, blocked ? `${blocked.retryAfterSeconds}s` : "");
  chkTrue("限流按 key 分开（别的 IP 不受影响）", checkRateLimit("9.9.9.9").allowed === true);
  resetRateLimit();
  chkTrue("resetRateLimit 清空后恢复", checkRateLimit("1.2.3.4").allowed === true);
}

// ===== 6–9. HTTP 层 =====
// ⚠️ 端口必须每次随机：上一轮若有服务没被 kill（测试崩掉时 finally 跑不到），
//    它会一直占着端口，新 spawn 的实例绑不上，健康检查就会连到**旧的**服务上，
//    断言结果被污染（反向验证时踩过：表现是"限流没生效"）。
let nextPort = 4300 + Math.floor(Math.random() * 400);
const takePort = () => nextPort++;

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: "account-test-key-0123456789",
      // 不设 CLOUDBASE_ENV_ID：走内存仓库，测试不连云环境。
      ...Object.fromEntries(Object.entries(extraEnv).filter(([, v]) => v !== undefined)),
      ...(extraEnv.CLOUDBASE_ENV_ID === undefined ? { CLOUDBASE_ENV_ID: "" } : {})
    }
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${base}/api/health`); if (res.ok) return { server, base }; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 50));
  }
  server.kill();
  throw new Error(`服务没能在 10s 内起来（port ${port}）`);
};
const postTicket = async (base, body) => {
  const res = await fetch(`${base}/api/account/ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log("\n--- 6. HTTP：正常签发（首开自动建号） ---");
{
  const { server, base } = await startServer({ [CREDENTIALS_ENV]: toBase64(makeCredentials()) }, takePort());
  try {
    const created = await postTicket(base, {});
    chk("不传 uid → 200", created.status, 200);
    chkTrue("返回的 uid 是服务端生成的", GENERATED_UID_PATTERN.test(created.body.data?.uid || ""), created.body.data?.uid);
    chk("标记 generated=true", created.body.data?.generated, true);
    chkTrue("票据非空", typeof created.body.data?.ticket === "string" && created.body.data.ticket.length > 0);
    chk("明示票据有效期 600 秒（SDK 固定，拿到要尽快用）", created.body.data?.ticketValidSeconds, 600);
    chkTrue("会话时长是秒数", typeof created.body.data?.sessionTtlSeconds === "number" && created.body.data.sessionTtlSeconds > 0);
    // 前端 init SDK 必须知道环境 ID。由服务端下发，前端就不必硬编码 —— 否则换环境要改两处，
    // 改漏一处的表现是"静默登到另一个环境"，是最难查的一类错。
    chk("响应里下发 env（供前端 init SDK）", created.body.data?.env, KEY_ENV);

    const existing = await postTicket(base, { uid: "dominik-device-01" });
    chk("传入 uid → 200", existing.status, 200);
    chk("传入的 uid 原样返回", existing.body.data?.uid, "dominik-device-01");
    chk("generated=false", existing.body.data?.generated, false);

    const health = await (await fetch(`${base}/api/health`)).json();
    chk("health 里有 account 段", health.account.configured, true);
  } finally { server.kill(); }
}

console.log("\n--- 7. HTTP：非法 uid 必须 400，不能放行 ---");
{
  const { server, base } = await startServer({ [CREDENTIALS_ENV]: toBase64(makeCredentials()) }, takePort());
  try {
    for (const [name, uid] of [["含斜杠", "bad/uid"], ["超长", "a".repeat(33)], ["太短", "ab"]]) {
      const res = await postTicket(base, { uid });
      chk(`${name} → 400`, res.status, 400);
      chkTrue(`${name} → 报错说明允许什么格式`, (res.body.error || "").includes("4–32 位"), res.body.error);
    }
  } finally { server.kill(); }
}

console.log("\n--- 8. HTTP：没配私钥必须 503，不能伪装成 500 ---");
{
  const { server, base } = await startServer({}, takePort());
  try {
    const res = await postTicket(base, {});
    chk("未配置 → 503", res.status, 503);
    chkTrue("503 文案说清是「没配私钥」", (res.body.error || "").includes("未启用"), res.body.error);
    chkTrue("503 提示里给出变量名", (res.body.hint || "").includes(CREDENTIALS_ENV), res.body.hint);
    const health = await (await fetch(`${base}/api/health`)).json();
    chk("health.account 报未配置", health.account.configured, false);
    chkTrue("health.account 带原因", health.account.error.includes("未配置"));
  } finally { server.kill(); }
}

console.log("\n--- 9. HTTP：限流生效（阈值调小后第 N+1 次被拦） ---");
{
  const { server, base } = await startServer({
    [CREDENTIALS_ENV]: toBase64(makeCredentials()),
    ACCOUNT_TICKET_RATE_LIMIT: "3"
  }, takePort());
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await postTicket(base, {})).status);
    chk("前 3 次放行", statuses.slice(0, 3), [200, 200, 200]);
    chk("第 4 次起被拦", statuses.slice(3), [429, 429]);
    const last = await postTicket(base, {});
    chkTrue("429 文案给出重试秒数", /请 \d+ 秒后再试/.test(last.body.error || ""), last.body.error);
  } finally { server.kill(); }
}

console.log("\n----");
console.log(`account.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
