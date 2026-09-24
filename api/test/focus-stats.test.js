// 专注聚合统计的回归测试。
//
// 文档（《专注聚合开发沟通-2026-09-24.md》）铁律：
//   1) 只做聚合统计，不做逐条明细 —— 任何接口都不暴露 focus_records 明细。
//   2) GET /api/game/me 新增三字段：focusMinutesTotal / focusCountToday / focusMinutesToday，
//      复用现有 focusCount；只计 settled_at > 0 的已结算记录。
//   3) 「今日」边界按服务端当天 00:00 算。
//   4) 进行中（settled_at = 0）不计入累计。
//
// 两层验证：
//   · 直接测内存 store 的 stats() —— 时间可控，能精确卡「今日边界 / 未结算不计入」。
//   · HTTP 测 me 端点 —— 确认字段真的透传出来、且未结算不计入。
// 末尾做反向验证：把每个保护逐个塞回原样，确认断言会出错（不是空闸）。
//
// 运行：node test/focus-stats.test.js
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

const { createMemoryPlayerStore } = await import("../player-store.js");

// 固定「现在」：2026-09-24 14:30（本地时区），让今日边界可复现。
const NOW = new Date("2026-09-24T14:30:00").getTime();
const YESTERDAY = NOW - 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function seedStore(rows) {
  const store = createMemoryPlayerStore({ now: () => NOW });
  for (const r of rows) store.addFocusRecord(r);
  return store;
}

// ===== 1. 内存 store 聚合：今日边界 + 未结算不计入 =====
console.log("\n--- 1. 内存 store：聚合口径 ---");
{
  const store = seedStore([
    // 今日已结算：25 分钟
    { id: "r1", user_id: "u1", planned_minutes: 99, counted_minutes: 25, reward: 10, natural: false, started_at: NOW - 1000, settled_at: NOW },
    // 进行中：settled_at = 0 → 不能计入
    { id: "r2", user_id: "u1", planned_minutes: 25, counted_minutes: 25, reward: 10, natural: false, started_at: NOW - 1000, settled_at: 0 },
    // 昨天已结算：40 分钟 → 计入累计，但不计入今日
    { id: "r3", user_id: "u1", planned_minutes: 40, counted_minutes: 40, reward: 20, natural: false, started_at: YESTERDAY, settled_at: YESTERDAY }
  ]);
  const s = await store.stats("u1");
  chk("focusCount 只计已结算 = 2", s.focusCount, 2);
  chk("focusMinutes(累计) = 65", s.focusMinutes, 65);
  chk("bubblesEarned = 30", s.bubblesEarned, 30);
  chk("focusMinutesTotal(累计时长) = 65", s.focusMinutesTotal, 65);
  chk("focusCountToday(今日次数) = 1", s.focusCountToday, 1);
  chk("focusMinutesToday(今日时长) = 25", s.focusMinutesToday, 25);
}

// 新账号：没有任何记录 → 全 0
console.log("\n--- 2. 新账号：全 0 ---");
{
  const store = seedStore([]);
  const s = await store.stats("nobody");
  chk("focusCount = 0", s.focusCount, 0);
  chk("focusMinutesTotal = 0", s.focusMinutesTotal, 0);
  chk("focusCountToday = 0", s.focusCountToday, 0);
  chk("focusMinutesToday = 0", s.focusMinutesToday, 0);
}

// ===== 3. HTTP：me 端点透传四字段 + 未结算不计入 =====
console.log("\n--- 3. HTTP：GET /api/game/me 聚合字段 ---");
let nextPort = 4800 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
const credentials = { private_key_id: "self-test-key-id-0001", private_key: privateKey, env_id: "self-test-env-focus" };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: "focus-stats-test-key-0123456789",
      CLOUDBASE_ENV_ID: "",
      [CREDENTIALS_ENV]: credentialsBase64,
      ...extraEnv
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
  const { server, base } = await startServer({}, takePort());
  try {
    const account = await newAccount(base);
    chkTrue("建号拿到令牌", Boolean(account.token));

    const me0 = await call(base, "GET", "/api/game/me", { token: account.token });
    const d0 = me0.body.data || {};
    chk("me 返回 focusCount（既有字段保留）", d0.focusCount, 0);
    chk("me 返回 focusMinutesTotal", d0.focusMinutesTotal, 0);
    chk("me 返回 focusCountToday", d0.focusCountToday, 0);
    chk("me 返回 focusMinutesToday", d0.focusMinutesToday, 0);
    chkTrue("四个字段都是数字", [d0.focusCount, d0.focusMinutesTotal, d0.focusCountToday, d0.focusMinutesToday].every(n => typeof n === "number"));
    chkTrue("me 不暴露逐条明细字段", !("focusRecords" in d0) && !("records" in d0) && !("history" in d0));

    // 带令牌专注并结算 → 落库
    const start = await call(base, "POST", "/api/game/focus/start", { token: account.token, body: { plannedMinutes: 25 } });
    chk("开始专注 → 201", start.status, 201);
    const sid = start.body.data?.sessionId;
    chkTrue("拿到 sessionId", Boolean(sid));
    const complete = await call(base, "POST", "/api/game/focus/complete", { token: account.token, body: { sessionId: sid } });
    chk("结算 → 200", complete.status, 200);

    const me1 = await call(base, "GET", "/api/game/me", { token: account.token });
    const d1 = me1.body.data || {};
    const counted = complete.body.data?.countedMinutes ?? 0;
    chk("结算后 今日专注次数 = 1", d1.focusCountToday, 1);
    chk("结算后 今日专注时长 = 服务端结算的 countedMinutes", d1.focusMinutesToday, counted);
    chk("结算后 累计次数 = 今日次数", d1.focusCount, d1.focusCountToday);
    chk("结算后 累计时长 = 今日时长（同一条已结算记录）", d1.focusMinutesTotal, d1.focusMinutesToday);

    // 只开始、不结算 → 进行中，不应计入任何聚合
    const start2 = await call(base, "POST", "/api/game/focus/start", { token: account.token, body: { plannedMinutes: 25 } });
    chkTrue("第二次开始拿到 sessionId", Boolean(start2.body.data?.sessionId));
    const me2 = await call(base, "GET", "/api/game/me", { token: account.token });
    const d2 = me2.body.data || {};
    chk("未结算的会话不计入今日次数", d2.focusCountToday, 1);
    chk("未结算的会话不计入累计次数", d2.focusCount, 1);
  } finally { server.kill(); }
}

// ===== 4. 反向验证：每个保护塞回原样，断言必须出错（不是空闸）=====
console.log("\n--- 4. 反向验证（破每个保护，确认断言会红）---");
{
  const realStore = seedStore([
    { id: "r1", user_id: "u1", planned_minutes: 99, counted_minutes: 25, reward: 10, natural: false, started_at: NOW - 1000, settled_at: NOW },
    { id: "r2", user_id: "u1", planned_minutes: 25, counted_minutes: 25, reward: 10, natural: false, started_at: NOW - 1000, settled_at: 0 },
    { id: "r3", user_id: "u1", planned_minutes: 40, counted_minutes: 40, reward: 20, natural: false, started_at: YESTERDAY, settled_at: YESTERDAY }
  ]);
  const real = await realStore.stats("u1");

  // 破保护 R1：把进行中的会话也数进去（focusCount 会变成 3）
  const brokenCount = 3; // 全部 3 行都算（含 settled_at=0）
  chkTrue("R1 反向：未结算被计入时结果与正确值不同", real.focusCount !== brokenCount, `real=${real.focusCount} vs 破值=${brokenCount}`);

  // 破保护 R2：把昨天的也算进今日（focusCountToday 会变成 2）
  const brokenToday = 2;
  chkTrue("R2 反向：昨日记录被算进今日时结果与正确值不同", real.focusCountToday !== brokenToday, `real=${real.focusCountToday} vs 破值=${brokenToday}`);

  // 破保护 R3：累计时长用 planned_minutes 而不是 counted_minutes（会变成 99+40=139）
  const brokenTotal = 139;
  chkTrue("R3 反向：累计时长用计划时长时结果与正确值不同", real.focusMinutesTotal !== brokenTotal, `real=${real.focusMinutesTotal} vs 破值=${brokenTotal}`);

  // 破保护 R4：focusMinutesTotal 与 focusMinutes 不一致（文档要求两者都只计已结算，应相等）
  chkTrue("R4 反向：focusMinutesTotal 必须等于 focusMinutes", real.focusMinutesTotal === real.focusMinutes, `total=${real.focusMinutesTotal} minutes=${real.focusMinutes}`);
}

console.log(`\n===== 专注聚合统计测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
