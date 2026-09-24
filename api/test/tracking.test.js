// 埋点（定稿第三步：打开 / 开始专注 / 完成专注 / 购买成功）回归测试。
//
// 关键约束（《上线准备清单》#3）：个人版云托管日志只保留 2 小时，
// 所以埋点必须**落库 RDB**，验收是数据真的进了 tracking_events 表。
//
// 分工：
//   · open        —— 客户端每次页面加载上报一次（POST /api/game/track，只收这一个事件）；
//   · focus_start / focus_complete / purchase
//                 —— 服务端在权威时机直接落库，不接受客户端代报（客户端说"买好了"不算数）。
//
// 覆盖：内存 store 的今日/7日/累计边界、CloudBase 桩 db（并锁死「无 order 方法」的
// SDK 面貌）、HTTP 链路（鉴权 / 白名单 / 防重放不重复埋点 / 购买落点）、
// index.html 的 trackOpen（每次加载恰好一次、失败静默）。
//
// 运行：node test/tracking.test.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const repoRoot = path.join(here, "..", "..");
const playerSource = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

let pass = 0, fail = 0;
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

const { createMemoryPlayerStore, createCloudbasePlayerStore } = await import("../player-store.js");

const NOW = new Date("2026-09-24T14:30:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

// ===== 1. 内存 store：trackSummary 的今日 / 7日 / 累计边界 =====
console.log("\n--- 1. 内存 store：addTrackingEvent / trackSummary ---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await store.addTrackingEvent({ userId: "u1", event: "open", at: NOW });            // 今天
  await store.addTrackingEvent({ userId: "u1", event: "open", at: NOW - 3 * DAY });  // 7 天内
  await store.addTrackingEvent({ userId: "u1", event: "open", at: NOW - 10 * DAY }); // 7 天外
  await store.addTrackingEvent({ userId: "u2", event: "focus_start", at: NOW });
  await store.addTrackingEvent({ userId: "u2", event: "purchase", at: NOW - 5 * DAY, detail: '{"paid":20}' });

  const s = await store.trackSummary();
  chk("概览恰好四行（白名单顺序）", s.map(r => r.event), ["open", "focus_start", "focus_complete", "purchase"]);
  const open = s.find(r => r.event === "open");
  chk("open 今日 = 1", open.today, 1);
  chk("open 最近 7 天 = 2（7 天外的不算）", open.last7d, 2);
  chk("open 累计 = 3", open.total, 3);
  const start = s.find(r => r.event === "focus_start");
  chk("focus_start 今日 = 1", start.today, 1);
  chk("focus_start 累计 = 1", start.total, 1);
  const purchase = s.find(r => r.event === "purchase");
  chk("purchase 今日 = 0（5 天前的）", purchase.today, 0);
  chk("purchase 最近 7 天 = 1", purchase.last7d, 1);
  chk("focus_complete 没有记录时全 0", s.find(r => r.event === "focus_complete"), { event: "focus_complete", today: 0, last7d: 0, total: 0 });
}

// ===== 2. CloudBase store（桩 db：无 order，锁死已验证的 SDK 面貌）=====
console.log("\n--- 2. CloudBase store：桩 db ---");
{
  const inserted = [];
  let selected = false;
  const stubDb = {
    from(table) {
      const builder = {};
      builder.select = () => { if (table === "tracking_events") selected = true; return builder; };
      builder.eq = () => builder;
      builder.insert = rows => { inserted.push({ table, rows }); return builder; };
      builder.throwOnError = () => Promise.resolve({
        data: table === "tracking_events"
          ? [{ event: "open", at: NOW }, { event: "open", at: NOW - 8 * DAY }, { event: "purchase", at: NOW }]
          : [],
        error: null
      });
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stubDb, { now: () => NOW });
  await store.addTrackingEvent({ userId: "u1", event: "open", detail: "d1" });
  chk("insert 落到 tracking_events 表", inserted.length, 1);
  const insertedRow = inserted[0].rows[0];
  chkTrue("insert 带 id 且是 te_ 开头的字符串（varchar 主键，应用层生成）",
    typeof insertedRow.id === "string" && insertedRow.id.startsWith("te_"));
  const { id: _id, ...rest } = insertedRow;
  chk("insert 行形状正确（id 之外为 user_id/event/detail/at）",
    rest, { user_id: "u1", event: "open", detail: "d1", at: NOW });
  const s = await store.trackSummary();
  chkTrue("trackSummary 走了 select（列裁剪交给 JS）", selected);
  const open = s.find(r => r.event === "open");
  chk("CloudBase 路径 open 累计 = 2", open.total, 2);
  chk("CloudBase 路径 open 今日 = 1", open.today, 1);
  chk("CloudBase 路径 open 7 天 = 1", open.last7d, 1);
}

// ===== 3. HTTP 全链路 =====
console.log("\n--- 3. HTTP：track 端点 / 权威落点 / 管理端概览 ---");
let nextPort = 5000 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
const credentials = { private_key_id: "self-test-key-id-0003", private_key: privateKey, env_id: "self-test-env-track" };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: "tracking-test-key-0123456789",
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
const call = async (base, method, urlPath, { token, adminKey, body } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (adminKey) headers["x-admin-key"] = adminKey;
  const res = await fetch(`${base}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

{
  const { server, base } = await startServer({}, takePort());
  try {
    const account = await call(base, "POST", "/api/account/ticket", { body: {} });
    const token = account.body.data?.token;
    chkTrue("建号拿到令牌", Boolean(token));

    // track 端点：鉴权 + 白名单
    const noAuth = await call(base, "POST", "/api/game/track", { body: { event: "open" } });
    chk("无令牌上报 → 401", noAuth.status, 401);
    const openRes = await call(base, "POST", "/api/game/track", { token, body: { event: "open" } });
    chk("open 上报 → 201", openRes.status, 201);
    const fakeStart = await call(base, "POST", "/api/game/track", { token, body: { event: "focus_start" } });
    chk("focus_start 不收客户端上报 → 400", fakeStart.status, 400);
    const bogus = await call(base, "POST", "/api/game/track", { token, body: { event: "_buy_all" } });
    chk("白名单外事件 → 400", bogus.status, 400);

    // 权威落点：专注开始 / 完成（重复结算不重复埋点）
    const start = await call(base, "POST", "/api/game/focus/start", { token, body: { plannedMinutes: 25 } });
    chk("开始专注 → 201", start.status, 201);
    const sid = start.body.data?.sessionId;
    await call(base, "POST", "/api/game/focus/complete", { token, body: { sessionId: sid } });
    await call(base, "POST", "/api/game/focus/complete", { token, body: { sessionId: sid } }); // 重放

    // 权威落点：购买成功（先有云存档才买得成）
    const saveRes = await call(base, "PUT", "/api/game/save", {
      token,
      body: {
        saveVersion: "0.2.0",
        PlayerData: { bubbles: 100, isMember: false, inventory: { fish: {}, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
        AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
        Settings: { audio: {} }
      }
    });
    chk("推送存档 → 200", saveRes.status, 200);
    const buy = await call(base, "POST", "/api/game/shop/buy", { token, body: { itemId: "decoration001" } });
    chk("购买 decoration001 → 200", buy.status, 200);

    // 管理端概览
    const noKey = await call(base, "GET", "/api/admin/track/summary");
    chk("概览无管理密钥 → 401", noKey.status, 401);
    const summary = await call(base, "GET", "/api/admin/track/summary", { adminKey: "tracking-test-key-0123456789" });
    chk("概览带密钥 → 200", summary.status, 200);
    const events = summary.body.data?.events || [];
    chk("概览恰好四行", events.length, 4);
    chk("open 落库 1 次", events.find(r => r.event === "open")?.total, 1);
    chk("focus_start 落库 1 次", events.find(r => r.event === "focus_start")?.total, 1);
    chk("focus_complete 只记 1 次（重放不重复）", events.find(r => r.event === "focus_complete")?.total, 1);
    chk("purchase 落库 1 次", events.find(r => r.event === "purchase")?.total, 1);
    chkTrue("四个事件都进了今日", events.every(r => r.today === 1), events.map(r => `${r.event}:${r.today}`).join(","));

    // 反向：若去掉防重放闸门，重放会把它变成 2 —— 与实际值 1 可区分。
    chkTrue("R1 反向：focus_complete 实际 1，重放翻倍会变成 2", (events.find(r => r.event === "focus_complete")?.total) !== 2);
    // 反向：若 track 端点不校验白名单，fakeStart/bogus 会 201 落库 → open 会变 3。
    chkTrue("R2 反向：白名单闸门真实存在（越权上报被 400 挡住）", fakeStart.status === 400 && bogus.status === 400);
  } finally { server.kill(); }
}

// ===== 4. index.html 的 trackOpen =====
console.log("\n--- 4. index.html：trackOpen 恰好一次 / 静默失败 ---");
const norm = text => text.replace(/\r\n/g, "\n");
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === ch) { j += 1; break; }
        if (text[j] === "\n" && ch !== "`") break;
        j += 1;
      }
      if (j > i + 1 && text[j - 1] === ch) { out += text.slice(i, j); i = j; continue; }
      out += ch; i += 1; continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop; continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop; continue;
    }
    out += ch; i += 1;
  }
  return out;
}
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  const isAsync = src.slice(Math.max(0, start - 6), start) === "async ";
  const begin = isAsync ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(begin, i + 1); }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}
const playerRaw = norm(playerSource);
const playerCode = stripComments(playerRaw);
{
  chkTrue("openTracked 旗标已声明", /let openTracked = false;/.test(playerRaw));
  const ensureSrc = extractFunction(playerCode, "ensureAccount");
  chk("ensureAccount 两个分支都接了 trackOpen（恰好 2 次）", (ensureSrc.match(/trackOpen\(\)/g) || []).length, 2);
  const trackSrc = extractFunction(playerCode, "trackOpen");
  chkTrue("trackOpen 有三重闸（开关 / 令牌 / 旗标）",
    /if\(!CLOUD_SYNC_ENABLED \|\| !ACCOUNT_TOKEN \|\| openTracked\) return;/.test(trackSrc));
  chkTrue("trackOpen 上报的是 open", /event:"open"/.test(trackSrc));
}

function makeTrackBox(fetchImpl, { enabled = true, token = "tok" } = {}) {
  const code = [
    'const API_BASE = "https://api.test/api";',
    `let ACCOUNT_TOKEN = ${JSON.stringify(token)};`,
    `let CLOUD_SYNC_ENABLED = ${enabled};`,
    "let openTracked = false;",
    "let fetchCalls = [];",
    'const console = { warn(){}, info(){}, log(){} };',
    "const fetch = (url, options) => { fetchCalls.push({ url, options }); return fetchImpl(url, options); };",
    extractFunction(playerCode, "cloudHeaders"),
    extractFunction(playerCode, "trackOpen"),
    "return { trackOpen, calls: () => fetchCalls, flag: () => openTracked };"
  ].join("\n");
  return new Function(code)();
}
{
  const box = makeTrackBox(async () => ({ ok: true }), { enabled: false, token: "" });
  await box.trackOpen();
  chk("无令牌时 trackOpen 不发请求", box.calls().length, 0);

  const box2 = makeTrackBox(async () => ({ ok: true }));
  await box2.trackOpen();
  await box2.trackOpen();
  const calls = box2.calls();
  chk("同一页面加载只发一次", calls.length, 1);
  chkTrue("请求打到 /game/track", calls[0].url.includes("/game/track"));
  chk("请求体是 open", JSON.parse(calls[0].options.body), { event: "open" });
  chkTrue("带 Bearer 令牌", (calls[0].options.headers.Authorization || "").startsWith("Bearer "));

  const box3 = makeTrackBox(async () => { throw new Error("网络炸了"); });
  let threw = false;
  try { await box3.trackOpen(); } catch { threw = true; }
  chkTrue("网络失败不抛异常（静默）", threw === false);
  chkTrue("失败也置旗标（本次加载不再重试）", box3.flag() === true);
}

console.log(`\n===== 埋点测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
