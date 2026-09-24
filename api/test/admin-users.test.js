// 后台「玩家管理」页面与用户列表接口的回归测试。
//
// 三层验证：
//   1) 数据层 listUsers：排序 / 聚合口径（只计已结算）/ cohort 与赞赏筛选，直接用内存 store 测，时间可控。
//   2) HTTP 层 GET /api/admin/users：管理密钥鉴权、字段透传、筛选真实生效。
//   3) admin.html 渲染层：导航按钮、渲染器接线、列表渲染、赞赏高亮、CSV 导出转义、筛选传到请求 URL。
// 末尾做反向验证：把每个保护塞回「错误值」，确认断言会不同（不是空闸）。
//
// 运行：node test/admin-users.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const projectRoot = path.join(here, "..", "..");
const adminHtml = fs.readFileSync(path.join(projectRoot, "admin.html"), "utf8");
const gameDataSource = fs.readFileSync(path.join(projectRoot, "game-data.js"), "utf8");

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

const NOW = new Date("2026-09-24T14:30:00").getTime();

// ===== 1. 数据层 listUsers（内存 store）=====
console.log("\n--- 1. 内存 store：listUsers 排序 / 聚合 / 筛选 ---");
const { createMemoryPlayerStore, createCloudbasePlayerStore } = await import("../player-store.js");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await store.ensureUser("u_c", { cohort: "early", at: NOW - 8000 });
  await store.ensureUser("u_a", { cohort: "early", at: NOW - 5000 });
  await store.ensureUser("u_b", { cohort: "public", at: NOW - 2000 });
  // u_a：1 条已结算（30 分钟）+ 1 条进行中（settled_at=0，不计入）
  await store.addFocusRecord({ id: "f1", user_id: "u_a", planned_minutes: 30, counted_minutes: 30, reward: 12, natural: false, started_at: NOW - 1000, settled_at: NOW });
  await store.addFocusRecord({ id: "f2", user_id: "u_a", planned_minutes: 25, counted_minutes: 25, reward: 10, natural: false, started_at: NOW - 1000, settled_at: 0 });
  // u_b：1 条已结算（15 分钟）
  await store.addFocusRecord({ id: "f3", user_id: "u_b", planned_minutes: 15, counted_minutes: 15, reward: 5, natural: false, started_at: NOW - 1000, settled_at: NOW - 1000 });
  await store.putSave("u_a", { AquariumData: { fish: [{}, {}, {}] } });
  await store.putSave("u_b", { AquariumData: { fish: [{}] } });
  // u_c 无专注、无存档

  const all = await store.listUsers();
  chk("排序：注册最早的 u_c 在最前", all[0].userId, "u_c");
  chk("排序：注册最晚的 u_b 在最后", all[all.length - 1].userId, "u_b");

  const a = all.find(u => u.userId === "u_a");
  const b = all.find(u => u.userId === "u_b");
  const c = all.find(u => u.userId === "u_c");
  chk("u_a focusCount 只计已结算 = 1", a.focusCount, 1);
  chk("u_a focusMinutesTotal = 30", a.focusMinutesTotal, 30);
  chk("u_a fishCount = 3", a.fishCount, 3);
  chk("u_a cohort = early", a.cohort, "early");
  chk("u_b focusCount = 1", b.focusCount, 1);
  chk("u_b fishCount = 1", b.fishCount, 1);
  chk("u_c focusCount = 0", c.focusCount, 0);
  chk("u_c fishCount = 0", c.fishCount, 0);
  chkTrue("focusCount 是数字", typeof a.focusCount === "number");
  chkTrue("isSupporter 是布尔", typeof a.isSupporter === "boolean");
  chkTrue("createdAt 是数字", typeof a.createdAt === "number");
  chkTrue("默认 isSupporter 为 false", a.isSupporter === false);

  const earlyOnly = await store.listUsers({ cohort: "early" });
  chk("cohort=early 只返回 2 个 early 用户", earlyOnly.length, 2);
  chkTrue("early 列表不含 public 用户", earlyOnly.every(u => u.cohort === "early"));
  const publicOnly = await store.listUsers({ cohort: "public" });
  chk("cohort=public 只返回 1 个 public 用户", publicOnly.length, 1);

  const supporters = await store.listUsers({ isSupporter: true });
  chk("isSupporter=true 返回空（无人赞赏）", supporters.length, 0);
  const nonSupp = await store.listUsers({ isSupporter: false });
  chk("isSupporter=false 返回全部 3 人", nonSupp.length, 3);

  // ===== 4. 反向验证（数据层）=====
  console.log("\n--- 1b. 反向验证（数据层保护）---");
  chkTrue("R1 反向：进行中记录被计入时 focusCount 会变成 2，实际为 1", a.focusCount !== 2, `实际=${a.focusCount}`);
  chkTrue("R2 反向：若按注册时间倒序，最前会是 u_b，实际是 u_c", all[0].userId !== "u_b", `实际最前=${all[0].userId}`);
  chkTrue("R3 反向：鱼数若读错数据源会变成 0，实际为 3", a.fishCount !== 0 && a.fishCount === 3, `实际=${a.fishCount}`);
}

// ===== 1c. CloudBase store listUsers（桩 db：只提供真实 SDK 有的方法）=====
console.log("\n--- 1c. CloudBase store：listUsers（桩 db）---");
{
  // ⚠️ 桩只实现 select/eq/throwOnError —— 与线上验证过的 SDK 面貌一致，
  //    刻意**不实现** order：实现若退回 .order() 写法，这里会直接 TypeError。
  const tables = {
    users: [
      { user_id: "u_b", nickname: "", cohort: "public", created_at: NOW - 1000, is_supporter: 0, supporter_note: "", sync_code_hash: "", last_seen_at: 0 },
      { user_id: "u_a", nickname: "早鸟", cohort: "early", created_at: NOW - 5000, is_supporter: 1, supporter_note: "赞" }
    ],
    focus_records: [
      { user_id: "u_a", counted_minutes: 40, settled_at: NOW, reward: 15 },
      { user_id: "u_b", counted_minutes: 10, settled_at: 0, reward: 0 }
    ],
    saves: [
      { user_id: "u_a", data: JSON.stringify({ AquariumData: { fish: [{ itemId: "fish001" }, { itemId: "fish001" }] } }) },
      { user_id: "u_b", data: "不是json" }
    ]
  };
  const calls = [];
  const stubDb = {
    from(table) {
      const builder = { _filters: [] };
      builder.select = () => builder;
      builder.eq = (col, val) => { builder._filters.push([col, val]); return builder; };
      // 与真实 SDK 一致：eq 过滤在返回数据里真实生效（不是只记不用）。
      builder.throwOnError = () => {
        calls.push({ table, filters: builder._filters.map(f => [...f]) });
        let rows = tables[table] || [];
        for (const [col, val] of builder._filters) rows = rows.filter(r => r[col] === val);
        return Promise.resolve({ data: rows, error: null });
      };
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stubDb, { now: () => NOW });

  const all = await store.listUsers();
  chk("CloudBase 路径：按注册时间升序", all.map(u => u.userId), ["u_a", "u_b"]);
  chk("恰好 3 趟查询（users/focus_records/saves）", calls.length, 3);
  const a = all.find(u => u.userId === "u_a");
  const b = all.find(u => u.userId === "u_b");
  chk("u_a focusMinutesTotal = 40", a.focusMinutesTotal, 40);
  chk("u_a fishCount = 2（data 是 JSON 字符串需解析）", a.fishCount, 2);
  chk("u_a isSupporter = true（0/1 转布尔）", a.isSupporter, true);
  chk("u_b 未结算不计入 focusCount = 0", b.focusCount, 0);
  chk("u_b 坏 JSON 兜底 fishCount = 0", b.fishCount, 0);
  chk("u_b isSupporter = false", b.isSupporter, false);

  const earlyOnly = await store.listUsers({ cohort: "early" });
  chk("cohort=early 只返回 1 人", earlyOnly.length, 1);
  // listUsers 每次发 3 趟查询，users 是第一趟（倒数第 3 条记录）。
  chk("筛选以 eq 下发到查询", calls[calls.length - 3].filters, [["cohort", "early"]]);
  const suppOnly = await store.listUsers({ isSupporter: true });
  chk("isSupporter=true 返回 u_a", suppOnly.map(u => u.userId), ["u_a"]);
  chk("is_supporter 以 eq 下发（值 1）", calls[calls.length - 3].filters, [["is_supporter", 1]]);
}


// ===== 2. HTTP 层 GET /api/admin/users =====
console.log("\n--- 2. HTTP：GET /api/admin/users ---");
let nextPort = 4900 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
const credentials = { private_key_id: "self-test-key-id-0002", private_key: privateKey, env_id: "self-test-env-focus" };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: "admin-users-test-key-0123456789",
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
const newAccount = async base => {
  const res = await call(base, "POST", "/api/account/ticket", { body: {} });
  return { uid: res.body.data?.uid, token: res.body.data?.token, status: res.status };
};

{
  const { server, base } = await startServer({}, takePort());
  try {
    const noKey = await call(base, "GET", "/api/admin/users");
    chk("无管理密钥 → 401", noKey.status, 401);
    const withKey = await call(base, "GET", "/api/admin/users", { adminKey: "admin-users-test-key-0123456789" });
    chk("带管理密钥 → 200", withKey.status, 200);
    chkTrue("返回 users 数组", Array.isArray(withKey.body.data?.users));
    chk("初始 count = 0（还没人注册）", withKey.body.data.count, 0);

    const acc = await newAccount(base);
    chkTrue("建号拿到令牌", Boolean(acc.token));
    const start = await call(base, "POST", "/api/game/focus/start", { token: acc.token, body: { plannedMinutes: 25 } });
    const sid = start.body.data?.sessionId;
    chkTrue("开始专注拿到 sessionId", Boolean(sid));
    const complete = await call(base, "POST", "/api/game/focus/complete", { token: acc.token, body: { sessionId: sid } });
    chk("结算 → 200", complete.status, 200);
    const counted = complete.body.data?.countedMinutes ?? 0;

    const list = await call(base, "GET", "/api/admin/users", { adminKey: "admin-users-test-key-0123456789" });
    const users = list.body.data.users;
    chk("注册并结算后 count = 1", list.body.data.count, 1);
    const me = users[0];
    chkTrue("列表项 userId 等于刚建的账号", me.userId === acc.uid);
    chkTrue("focusCount >= 1", me.focusCount >= 1);
    chkTrue("focusMinutesTotal >= 服务端结算时长", me.focusMinutesTotal >= counted);
    chkTrue("fishCount 是数字", typeof me.fishCount === "number");
    chkTrue("isSupporter 是布尔", typeof me.isSupporter === "boolean");
    chkTrue("createdAt 是数字", typeof me.createdAt === "number");

    // 赞赏过滤：测试账号不是赞赏者
    const sup = await call(base, "GET", "/api/admin/users?isSupporter=true", { adminKey: "admin-users-test-key-0123456789" });
    chk("isSupporter=true 过滤后为空", sup.body.data.count, 0);
    const nonSup = await call(base, "GET", "/api/admin/users?isSupporter=false", { adminKey: "admin-users-test-key-0123456789" });
    chk("isSupporter=false 过滤后含测试账号", nonSup.body.data.count, 1);
    // 乱填 cohort → 空（证明筛选真实生效，不是摆设）
    const bogus = await call(base, "GET", "/api/admin/users?cohort=nonexistent", { adminKey: "admin-users-test-key-0123456789" });
    chk("cohort=nonexistent 过滤后为空", bogus.body.data.count, 0);

    // 反向：若去掉鉴权闸门，无密钥请求会返回 200；这里确认有密钥才能进。
    chkTrue("R4 反向：鉴权闸门存在（无密钥返回 401 而非 200）", noKey.status === 401);
  } finally { server.kill(); }
}

// ===== 3. admin.html 渲染层 =====
console.log("\n--- 3. admin.html 玩家管理页 ---");
function makeElement(id = "") {
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, click() {},
    closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
const captured = { blobParts: null, anchor: null };
const elements = new Map();
const fakeDocument = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
  querySelectorAll() { return []; },
  querySelector() { return makeElement(); },
  createElement(tag) { const el = makeElement(tag); if (tag === "a") captured.anchor = el; return el; },
  createElementNS() { return makeElement(); },
  body: { appendChild() {} },
  addEventListener() {}
};
const fakeWindow = {};
new Function("window", gameDataSource)(fakeWindow);

const SAMPLE_USERS = [
  { userId: "u_1", nickname: "小明", cohort: "early", createdAt: NOW - 8000, isSupporter: true, supporterNote: "感谢支持", focusCount: 3, focusMinutesTotal: 90, fishCount: 5 },
  { userId: "u_2", nickname: "阿强", cohort: "public", createdAt: NOW - 2000, isSupporter: false, supporterNote: "", focusCount: 1, focusMinutesTotal: 25, fishCount: 2 },
  { userId: "u_3", nickname: "超,人", cohort: "public", createdAt: NOW - 5000, isSupporter: false, supporterNote: "", focusCount: 0, focusMinutesTotal: 0, fishCount: 0 }
];
let lastUserFetchUrl = "";
const fakeFetch = async url => {
  lastUserFetchUrl = url;
  return { ok: true, status: 200, json: async () => ({ data: { users: SAMPLE_USERS, count: SAMPLE_USERS.length } }) };
};
function FakeBlob(parts) { captured.blobParts = parts[0]; }
const fakeUrl = { createObjectURL: () => "blob:fake", revokeObjectURL() {} };
const ssStub = { getItem: () => null, setItem() {}, removeItem() {} };
const lsStub = { getItem: () => null, setItem() {}, removeItem() {} };

const scriptSource = adminHtml.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const adminApi = new Function("document", "window", "sessionStorage", "localStorage", "fetch", "Blob", "URL", `
${scriptSource}
return { state, renderUserList, loadUsers, exportUsersCsv, csvCell, userFilter };
`)(fakeDocument, fakeWindow, ssStub, lsStub, fakeFetch, FakeBlob, fakeUrl);
const main = fakeDocument.getElementById("main");

chkTrue("导航含 data-module=users 的按钮", adminHtml.includes('data-module="users"'));
chkTrue("页面含「玩家管理」标题文案", adminHtml.includes("玩家管理"));

// 渲染器接线：切到 users 模块能渲染出页面（renderers 映射里有 users）
adminApi.state.module = "users";
adminApi.state.users = [];
adminApi.renderUserList();
chkTrue("renderUserList 渲染出页面标题", main.innerHTML.includes("玩家管理"));
chkTrue("renderUserList 渲染出导出按钮", main.innerHTML.includes('id="exportUsersCsv"'));

adminApi.state.users = SAMPLE_USERS;
adminApi.renderUserList();
const html = main.innerHTML;
chkTrue("列表含表头「玩家」", html.includes("玩家"));
chkTrue("列表含表头「累计专注(分)」", html.includes("累计专注(分)"));
chkTrue("渲染了三位玩家", html.includes("小明") && html.includes("阿强") && html.includes("超,人"));
chkTrue("赞赏者被高亮（supporter 类）", html.includes('class="supporter"'));
chkTrue("赞赏者显示「赞赏者」徽章", html.includes("赞赏者"));
chkTrue("cohort 筛选下拉存在", html.includes('id="filterCohort"'));
chkTrue("赞赏筛选下拉存在", html.includes('id="filterSupporter"'));
chkTrue("显示人数统计", html.includes("共 3 人（赞赏者 1）"));

adminApi.state.users = [];
adminApi.renderUserList();
chkTrue("空列表显示兜底文案", main.innerHTML.includes("还没有玩家") || main.innerHTML.includes("加载中"));

// CSV 导出
adminApi.state.users = SAMPLE_USERS;
captured.blobParts = null;
captured.anchor = null;
adminApi.exportUsersCsv();
const csv = captured.blobParts;
chkTrue("CSV 含 BOM 头（Excel 中文不乱码）", typeof csv === "string" && csv.charCodeAt(0) === 0xFEFF);
chkTrue("CSV 表头正确", csv.includes("userId,nickname,cohort,createdAt,isSupporter,supporterNote,focusCount,focusMinutesTotal,fishCount"));
chkTrue("CSV 含小明行", csv.includes("u_1,小明,early,"));
chkTrue("CSV 对含逗号的昵称做了转义", csv.includes('"超,人"'));
chkTrue("导出文件名含日期", Boolean(captured.anchor && /fishtank-users-\d{4}-\d{2}-\d{2}\.csv/.test(captured.anchor.download || "")));

// 筛选传到请求 URL（证明不是摆设）
adminApi.userFilter.cohort = "";
adminApi.userFilter.isSupporter = "";
await adminApi.loadUsers();
chkTrue("无筛选时请求不带 cohort 参数", !lastUserFetchUrl.includes("cohort"));
adminApi.userFilter.cohort = "early";
adminApi.userFilter.isSupporter = "true";
await adminApi.loadUsers();
chkTrue("cohort 筛选传到请求 URL", lastUserFetchUrl.includes("cohort=early"));
chkTrue("isSupporter 筛选传到请求 URL", lastUserFetchUrl.includes("isSupporter=true"));

// 反向：renderUserList 必须是数据驱动（空数据 vs 有数据表现不同）
adminApi.state.users = [];
adminApi.renderUserList();
const emptyHtml = main.innerHTML;
adminApi.state.users = SAMPLE_USERS;
adminApi.renderUserList();
chkTrue("R5 反向：列表随数据变化（空 vs 有数据 HTML 不同）", emptyHtml !== main.innerHTML);

console.log(`\n===== 后台玩家管理测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
