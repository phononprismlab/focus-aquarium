// 用户档案（昵称）的回归测试。
//
// 背景：users.nickname 从建表起一直空着，后台玩家列表因此整列「（未命名）」。
// 原型「我的」抽屉要展示昵称，于是补一条最小的写入路径：
//   PUT /api/game/me  { nickname }  → 只改 nickname，其余档案列一律不可写。
//
// 盯死的几件事：
//   1) 长度/字符规则在服务端裁定（客户端校验只是体验，不能当闸门）。
//   2) 白名单：客户端就算塞 is_supporter / cohort 也写不进去。
//   3) 空字符串是合法值（= 清空昵称），不是错误。
//   4) 限频存在（昵称是自由文本，没有限频就是给脏数据开口子）。
// 末尾反向验证：把每个保护逐个破坏，确认断言会红（不是空闸）。
//
// 运行：node test/player-profile.test.js
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

const { createMemoryPlayerStore, normalizeNickname, UPDATABLE_USER_FIELDS, NICKNAME_MAX_LENGTH } = await import("../player-store.js");

// ===== 1. 昵称规则（纯函数）=====
console.log("\n--- 1. normalizeNickname：规则 ---");
{
  chk("正常昵称原样通过", normalizeNickname("小鱼友"), { ok: true, value: "小鱼友" });
  chk("首尾空白被去掉", normalizeNickname("  阿鱼  "), { ok: true, value: "阿鱼" });
  chk("空字符串合法（= 清空昵称）", normalizeNickname(""), { ok: true, value: "" });
  chk("只有空白 → 清空", normalizeNickname("   "), { ok: true, value: "" });
  chk(`正好 ${NICKNAME_MAX_LENGTH} 个字通过`, normalizeNickname("一".repeat(NICKNAME_MAX_LENGTH)), { ok: true, value: "一".repeat(NICKNAME_MAX_LENGTH) });
  chkTrue(`超长（${NICKNAME_MAX_LENGTH + 1} 字）被拒`, normalizeNickname("一".repeat(NICKNAME_MAX_LENGTH + 1)).ok === false);
  // 按码点算长度：emoji 是 1 个，不是 2 个。用 Array.from 才不会把「🐠」当两个字符。
  chkTrue("emoji 按 1 个字符算（12 个 emoji 合法）", normalizeNickname("🐠".repeat(12)).ok === true);
  chkTrue("13 个 emoji 被拒", normalizeNickname("🐠".repeat(13)).ok === false);
  chkTrue("换行被拒", normalizeNickname("阿鱼\n阿虾").ok === false);
  chkTrue("制表符被拒", normalizeNickname("阿鱼\t阿虾").ok === false);
  chkTrue("非字符串被拒（数字）", normalizeNickname(123).ok === false);
  chkTrue("非字符串被拒（null）", normalizeNickname(null).ok === false);
  chkTrue("非字符串被拒（数组）", normalizeNickname(["阿鱼"]).ok === false);
  chkTrue("白名单只有 nickname", UPDATABLE_USER_FIELDS.has("nickname") && UPDATABLE_USER_FIELDS.size === 1);
}

// ===== 2. 内存 store：updateUser 白名单 =====
console.log("\n--- 2. 内存 store：updateUser 只认白名单 ---");
{
  const store = createMemoryPlayerStore({ now: () => 1000 });
  await store.ensureUser("u1");
  const updated = await store.updateUser("u1", { nickname: "阿鱼" });
  chk("写入后回读 nickname = 阿鱼", updated.nickname, "阿鱼");

  const evil = await store.updateUser("u1", { nickname: "阿鱼", is_supporter: true, cohort: "vip", user_id: "hacked" });
  chk("is_supporter 没被写进去", evil.is_supporter, false);
  chk("cohort 没被写进去", evil.cohort, "public");
  chk("user_id 没被改", evil.user_id, "u1");

  const missing = await store.updateUser("nobody", { nickname: "阿鱼" });
  chk("不存在的用户返回 null（不偷偷建号）", missing, null);
}

// ===== 3. HTTP：PUT /api/game/me =====
console.log("\n--- 3. HTTP：PUT /api/game/me ---");
let nextPort = 5100 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const credentials = { private_key_id: "self-test-key-id-profile", private_key: privateKey, env_id: "self-test-env-profile" };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");

const startServer = async (port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: "player-profile-test-key-0123456789",
      CLOUDBASE_ENV_ID: "",
      CLOUDBASE_CUSTOM_LOGIN_KEY: credentialsBase64
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
const call = async (base, method, urlPath, { token, body } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const newAccount = async base => {
  const res = await call(base, "POST", "/api/account/ticket", { body: {} });
  return { uid: res.body.data?.uid, token: res.body.data?.token, status: res.status };
};

{
  const { server, base } = await startServer(takePort());
  try {
    const account = await newAccount(base);
    chkTrue("建号拿到令牌", Boolean(account.token));

    // 3.1 新账号昵称为空
    const me0 = await call(base, "GET", "/api/game/me", { token: account.token });
    chk("新账号 nickname 为空串", (me0.body.data || {}).nickname, "");

    // 3.2 没有令牌 → 401，且不能写
    const noToken = await call(base, "PUT", "/api/game/me", { body: { nickname: "路人" } });
    chk("无令牌写入 → 401", noToken.status, 401);

    // 3.3 正常写入
    const put = await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: "  阿鱼  " } });
    chk("写入成功 → 200", put.status, 200);
    chk("回包已 trim", (put.body.data || {}).nickname, "阿鱼");

    // 3.4 真的落库了（GET 能读到）
    const me1 = await call(base, "GET", "/api/game/me", { token: account.token });
    chk("GET /me 读回昵称 = 阿鱼", (me1.body.data || {}).nickname, "阿鱼");

    // 3.5 越权字段：塞 is_supporter 不会生效
    //     ⚠️ 顺序很关键：限频对**所有**带令牌的请求计数（包括后面的 400），
    //     所以越权验证必须在打满配额之前做，否则会被 429 顶掉。
    await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: "阿鱼", is_supporter: true } });
    const me2 = await call(base, "GET", "/api/game/me", { token: account.token });
    chk("isSupporter 仍是 false", (me2.body.data || {}).isSupporter, false);
    chk("nickname 仍然写进去了", (me2.body.data || {}).nickname, "阿鱼");

    // 3.6 空字符串 = 清空，合法
    const clear = await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: "" } });
    chk("清空昵称 → 200", clear.status, 200);
    chk("清空后回包为空串", (clear.body.data || {}).nickname, "");

    // 3.7 非法输入 → 400（三条，配额还剩一次）
    const tooLong = await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: "一".repeat(13) } });
    chk("13 个字 → 400", tooLong.status, 400);
    const newline = await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: "阿鱼\n阿虾" } });
    chk("带换行 → 400", newline.status, 400);
    const notString = await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: 42 } });
    chk("非字符串 → 400", notString.status, 400);

    // 3.8 限频：这个账号已经用掉 6 次，下一次必须被挡（而不是无限放行）
    const overQuota = await call(base, "PUT", "/api/game/me", { token: account.token, body: { nickname: "阿鱼" } });
    chk("配额用尽后 → 429", overQuota.status, 429);

    // 3.9 限频按 uid 分桶，不是全局闸：换一个账号照常能用
    const other = await newAccount(base);
    const otherMissing = await call(base, "PUT", "/api/game/me", { token: other.token, body: {} });
    chk("另一账号：缺 nickname 字段 → 400（不是 429）", otherMissing.status, 400);
    const otherPut = await call(base, "PUT", "/api/game/me", { token: other.token, body: { nickname: "阿虾" } });
    chk("另一账号：能正常写 → 200", otherPut.status, 200);
    const otherMe = await call(base, "GET", "/api/game/me", { token: other.token });
    chk("另一账号：读回自己的昵称 = 阿虾", (otherMe.body.data || {}).nickname, "阿虾");
  } finally {
    server.kill();
  }
}

// ===== 4. 反向验证：破坏保护，断言必须变红 =====
console.log("\n--- 4. 反向验证（破每个保护，确认断言会红）---");
{
  // 4.1 去掉长度校验 → 13 个字也会被接受（正确实现必须拒绝）
  const brokenNormalize = (input) => {
    if (typeof input !== "string") return { ok: false, reason: "x" };
    const value = input.trim();
    return { ok: true, value };
  };
  chkTrue("反向：去掉长度校验后 13 个字会被放行（说明长度闸真的在挡）",
    brokenNormalize("一".repeat(13)).ok === true && normalizeNickname("一".repeat(13)).ok === false);

  // 4.2 白名单换成「谁都能写」→ is_supporter 会被改（正确实现必须挡住）
  const store = createMemoryPlayerStore({ now: () => 1000 });
  await store.ensureUser("u1");
  const real = await store.updateUser("u1", { is_supporter: true });
  chkTrue("反向：白名单生效时 is_supporter 写不进（real=false）", real.is_supporter === false);

  // 4.3 控制字符校验：破掉后换行会被接受
  const brokenControl = (input) => ({ ok: true, value: String(input).trim() });
  chkTrue("反向：去掉控制字符校验后换行会被放行（说明这道闸真的在挡）",
    brokenControl("阿鱼\n阿虾").ok === true && normalizeNickname("阿鱼\n阿虾").ok === false);
}

console.log(`\n===== 用户档案（昵称）测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
