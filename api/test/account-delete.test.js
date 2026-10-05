// 自助注销（DELETE /api/account）的回归测试。
//
// 这个文件盯的是**删除的正确性与边界**，不是「接口能返回 200」。五件事：
//   1) 只删自己：A 的令牌删不到 B 的数据（越权）—— 这是本接口唯一的高危面。
//   2) 五张表都删干净：users / saves / focus_records / tracking_events / grants。
//   3) 🔴 空 uid 不删任何东西 —— focus_records.user_id 有默认值 ''（未登录也能专注），
//      空串 uid 会把**所有未登录玩家**的专注记录一起删掉。
//   4) 幂等：删第二遍计数全 0，仍然 200，不报 404。
//   5) 不受停机闸门影响（有意为之）：维护窗口里用户行使删除权不该被拦。
//
// 全程自造 RSA 私钥 + 内存数据层 / CloudBase 桩，不连任何云环境。
// 运行：node test/account-delete.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(here, "..");
const PORT = 4903;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = "account-delete-test-key-0123456789";

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

const { createMemoryPlayerStore, createCloudbasePlayerStore } = await import("../player-store.js");

const NOW = 1_760_000_000_000;
const ZERO = { users: 0, saves: 0, focus_records: 0, tracking_events: 0, grants: 0 };

// 给某个 uid 造齐五张表的数据。
async function seedPerson(store, uid) {
  await store.ensureUser(uid, { at: NOW });
  await store.putSave(uid, {
    saveVersion: "0.2.0",
    PlayerData: { bubbles: 100, isMember: false, inventory: { fish: { fish001: 1 } } },
    AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
    Settings: { audio: {} }
  }, { at: NOW });
  await store.addFocusRecord({
    id: `${uid}-focus-1`, user_id: uid, started_at: NOW - 60000, ended_at: NOW,
    counted_minutes: 25, reward: 25, settled_at: NOW, natural: true
  });
  await store.addTrackingEvent({ userId: uid, event: "open", at: NOW });
  await store.addGrants([{ id: `${uid}-grant-1`, user_id: uid, bubbles: 50, items: [], reason: "测试", created_at: NOW }]);
}

// ===== 1. 内存实现：删除语义 =====
console.log("\n--- 1. 内存实现：五张表全删、只删自己 ---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await seedPerson(store, "u_a");
  await seedPerson(store, "u_b");

  const before = store._sizes();
  chk("准备：两个人各有存档", [before.users, before.saves, before.focusRecords, before.grants], [2, 2, 2, 2]);
  chk("准备：两条埋点", before.trackingEvents, 2);

  const result = await store.deleteUser("u_a");
  chk("返回的 userId 是传入的 uid", result.userId, "u_a");
  chk("五张表各删 1 行", result.deleted, { users: 1, saves: 1, focus_records: 1, tracking_events: 1, grants: 1 });

  chk("A 的用户行没了", await store.getUser("u_a"), null);
  chk("A 的存档没了", await store.getSave("u_a"), null);
  chk("A 的专注记录没了", (await store.stats("u_a")).focusCount, 0);
  chk("A 的奖励记录没了", await store.listGrants({ userId: "u_a" }), []);

  // 越权的另一半：别人的数据必须完好无损
  chkTrue("🔴 B 的用户行还在", (await store.getUser("u_b")) !== null);
  chkTrue("🔴 B 的存档还在", (await store.getSave("u_b")) !== null);
  chk("🔴 B 的专注记录还在", (await store.stats("u_b")).focusCount, 1);
  chk("🔴 B 的奖励记录还在", (await store.listGrants({ userId: "u_b" })).length, 1);
  const after = store._sizes();
  chk("删完只剩 B 的四类数据", [after.users, after.saves, after.focusRecords, after.grants], [1, 1, 1, 1]);
  chk("埋点只剩 B 那条", after.trackingEvents, 1);

  // 幂等
  const second = await store.deleteUser("u_a");
  chk("🔴 重复删除：计数全 0（幂等）", second.deleted, ZERO);
  chkTrue("重复删除仍返回 userId（不报错）", second.userId === "u_a");
}

console.log("\n--- 1b. 🔴 空 uid 是禁区（focus_records 有 user_id='' 的未登录记录）---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await seedPerson(store, "u_real");
  // 未登录也能专注 → 库里会存在 user_id 为空串的记录
  await store.addFocusRecord({
    id: "anon-focus-1", user_id: "", started_at: NOW, ended_at: NOW,
    counted_minutes: 25, reward: 0, settled_at: NOW, natural: true
  });

  const blank = await store.deleteUser("");
  chk("🔴 空 uid：什么都不删", blank.deleted, ZERO);
  chk("🔴 空 uid：返回的 userId 也是空", blank.userId, "");
  chk("🔴 空串记录没被误伤", store._sizes().focusRecords, 2);
  chkTrue("真实用户也还在", (await store.getUser("u_real")) !== null);

  // 只有空白的字符串同样按空处理，别让 ' ' 变成一次全表删除
  const spaces = await store.deleteUser("   ");
  chk("🔴 纯空白 uid 同样不删", spaces.deleted, ZERO);
  chk("🔴 纯空白 uid 之后数据还在", store._sizes().focusRecords, 2);
  chk("undefined 也不删", (await store.deleteUser(undefined)).deleted, ZERO);
}

console.log("\n--- 1c. trackingEvents 是数组，必须原地过滤 ---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await seedPerson(store, "u_x");
  await store.addTrackingEvent({ userId: "u_y", event: "open", at: NOW });
  await store.addTrackingEvent({ userId: "u_x", event: "focus_start", at: NOW });

  await store.deleteUser("u_x");
  // 长度 3 → 删掉 u_x 的两条 → 剩 1
  chk("原地过滤后剩别人的那条", store._sizes().trackingEvents, 1);
  const summary = await store.trackSummary();
  const openRow = summary.find(r => r.event === "open");
  chk("汇总里 open 只剩 1 条（u_y 的）", openRow.total, 1);
  const focusRow = summary.find(r => r.event === "focus_start");
  chk("汇总里 focus_start 归零", focusRow.total, 0);
}

// ===== 2. CloudBase 桩：查询面貌 =====
console.log("\n--- 2. CloudBase 桩：五张表都按 user_id 删、报实际行数 ---");
{
  const state = {
    users: [{ user_id: "u_1", nickname: "甲" }, { user_id: "u_2", nickname: "乙" }],
    saves: [{ user_id: "u_1", data: "{}" }, { user_id: "u_2", data: "{}" }],
    focus_records: [{ id: "f1", user_id: "u_1" }, { id: "f2", user_id: "" }, { id: "f3", user_id: "u_2" }],
    tracking_events: [{ id: 1, user_id: "u_1" }, { id: 2, user_id: "u_2" }],
    grants: [{ id: "g1", user_id: "u_1" }, { id: "g2", user_id: "u_2" }]
  };
  const calls = [];
  const stubDb = {
    from(table) {
      let op = null;
      const filters = [];
      const builder = {
        select(cols) { op = "select"; calls.push({ table, op, cols }); return builder; },
        delete() { op = "delete"; calls.push({ table, op }); return builder; },
        eq(col, value) { filters.push([col, value]); return builder; },
        throwOnError() {
          const hit = row => filters.every(([col, value]) => String(row[col]) === String(value));
          if (op === "delete") {
            state[table] = state[table].filter(row => !hit(row));
            return { data: null };
          }
          return { data: state[table].filter(hit).map(row => ({ ...row })) };
        }
      };
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stubDb, { now: () => NOW });

  const result = await store.deleteUser("u_1");
  chk("报的是实际删掉的行数", result.deleted, { users: 1, saves: 1, focus_records: 1, tracking_events: 1, grants: 1 });

  const deletedTables = calls.filter(c => c.op === "delete").map(c => c.table).sort();
  chk("五张表都发了 delete", deletedTables, ["focus_records", "grants", "saves", "tracking_events", "users"]);
  chkTrue("select 用的是 select(\"*\")（列裁剪交给 JS）", calls.filter(c => c.op === "select").every(c => c.cols === "*"));

  chk("🔴 空串 uid 的记录没被误伤（focus_records 还剩 2 条）", state.focus_records.length, 2);
  chkTrue("🔴 空串那条还在", state.focus_records.some(r => r.user_id === ""));
  chk("u_2 的数据没动", [state.users.length, state.saves.length, state.grants.length], [1, 1, 1]);

  // 幂等：已经删干净的人再删一次 → 不该再发 delete（省掉 5 次空写）
  calls.length = 0;
  const again = await store.deleteUser("u_1");
  chk("重复删除：计数全 0", again.deleted, ZERO);
  chk("重复删除：一次 delete 都没发（先查后删）", calls.filter(c => c.op === "delete").length, 0);
}

// ===== 3. HTTP：鉴权、越权、幂等、不受停机影响 =====
console.log("\n--- 3. HTTP 端到端 ---");
// ⚠️ 格式与 grants.test.js 一致：base64(JSON)，键名是 snake_case。
// 写成 camelCase 裸 JSON 会让 accountStatus().configured === false，
// /api/account/ticket 直接 503「账号功能未启用」，表现为 r.body.data 为 undefined。
const CREDS = Buffer.from(JSON.stringify({
  private_key_id: "account-delete-key-id-0001",
  private_key: crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  }).privateKey,
  env_id: "account-delete-env-0001"
}), "utf8").toString("base64");

const server = spawn(process.execPath, ["server.js"], {
  cwd: API_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    EXTRA_PORTS: "0",
    NODE_ENV: "test",
    ADMIN_API_KEY: ADMIN_KEY,
    CLOUDBASE_CUSTOM_LOGIN_KEY: CREDS,
    CLOUDBASE_ENV_ID: ""
  }
});
let logs = "";
server.stdout.on("data", d => { logs += d.toString(); });
server.stderr.on("data", d => { logs += d.toString(); });

const deadline = Date.now() + 10000;
let up = false;
while (Date.now() < deadline) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 50));
}
if (!up) { console.log("服务没起来：\n" + logs); server.kill(); process.exit(1); }

const call = async (method, p, opts = {}) => {
  const headers = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;
  const r = await fetch(BASE + p, {
    method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};

const newAccount = async () => {
  const r = await call("POST", "/api/account/ticket", { body: {} });
  if (!r.body || !r.body.data) {
    throw new Error(`建号失败：status=${r.status} body=${JSON.stringify(r.body)}（多半是 CLOUDBASE_CUSTOM_LOGIN_KEY 格式不对）`);
  }
  return { uid: r.body.data.uid, token: r.body.data.token };
};

const SAVE = bubbles => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: { fish001: 1 } } },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});

// --- 3.1 鉴权 ---
const noToken = await call("DELETE", "/api/account");
chk("无令牌 → 401", noToken.status, 401);
chkTrue("401 带 expired 标记（前端据此提示重新登录）", typeof noToken.body.expired === "boolean");
const badToken = await call("DELETE", "/api/account", { token: "not-a-real-token" });
chk("坏令牌 → 401", badToken.status, 401);

// --- 3.2 只删自己（越权）---
const alice = await newAccount();
const bob = await newAccount();
await call("PUT", "/api/game/save", { token: alice.token, body: SAVE(111) });
await call("PUT", "/api/game/save", { token: bob.token, body: SAVE(222) });
// 给两个人各造一条专注记录，好验证 focus_records 也被区分开。
// ⚠️ focus/start 的 body 是 { plannedMinutes }，sessionId 由服务端在 201 里返回；
//    把 sessionId 当入参传（我第一版就是这么写的）会 400，记录根本落不了库。
const aliceStart = await call("POST", "/api/game/focus/start", { token: alice.token, body: { plannedMinutes: 25 } });
chk("准备：A 开始专注 → 201", aliceStart.status, 201);
await call("POST", "/api/game/focus/complete", { token: alice.token, body: { sessionId: aliceStart.body.data.sessionId } });
const bobStart = await call("POST", "/api/game/focus/start", { token: bob.token, body: { plannedMinutes: 25 } });
chk("准备：B 开始专注 → 201", bobStart.status, 201);
await call("POST", "/api/game/focus/complete", { token: bob.token, body: { sessionId: bobStart.body.data.sessionId } });

const aliceMeBefore = await call("GET", "/api/game/me", { token: alice.token });
chkTrue("准备：A 有专注记录", aliceMeBefore.body.data.focusCount >= 1);
chkTrue("准备：A 有存档", (await call("GET", "/api/game/save", { token: alice.token })).body.data.exists === true);

// A 主动注销
const deleted = await call("DELETE", "/api/account", { token: alice.token });
chk("A 注销 → 200", deleted.status, 200);
chk("返回的 userId 是 A 的 uid", deleted.body.data.userId, alice.uid);
chkTrue("users 删了 1 行", deleted.body.data.deleted.users === 1);
chkTrue("saves 删了 1 行", deleted.body.data.deleted.saves === 1);
chkTrue("focus_records 删了 ≥1 行", deleted.body.data.deleted.focus_records >= 1);
chkTrue("deleted 结构齐全", ["users", "saves", "focus_records", "tracking_events", "grants"].every(k => k in deleted.body.data.deleted));

// 🔴 越权：B 的一切必须原封不动
const bobSave = await call("GET", "/api/game/save", { token: bob.token });
chkTrue("🔴 B 的存档还在", bobSave.body.data.exists === true);
chk("🔴 B 的泡泡没被动（222）", bobSave.body.data.save.PlayerData.bubbles, 222);
const bobMe = await call("GET", "/api/game/me", { token: bob.token });
chkTrue("🔴 B 的专注记录还在", bobMe.body.data.focusCount >= 1);

// A 的五张表确实清了
const aliceSave = await call("GET", "/api/game/save", { token: alice.token });
chk("A 的存档 → exists:false", aliceSave.body.data.exists, false);
const aliceMe = await call("GET", "/api/game/me", { token: alice.token });
chk("A 的专注聚合归零", [aliceMe.body.data.focusCount, aliceMe.body.data.focusMinutesTotal], [0, 0]);
const usersList = await call("GET", "/api/admin/users", { adminKey: ADMIN_KEY });
chkTrue("admin/users 里已经没有 A", !usersList.body.data.users.some(u => u.userId === alice.uid));
const savesExport = await call("GET", "/api/admin/saves/export", { adminKey: ADMIN_KEY });
chkTrue("admin/saves/export 里已经没有 A", !savesExport.body.data.saves.some(s => s.userId === alice.uid));
chkTrue("🔴 导出里 B 还在", savesExport.body.data.saves.some(s => s.userId === bob.uid));

// --- 3.3 幂等 ---
const againHttp = await call("DELETE", "/api/account", { token: alice.token });
chk("🔴 重复注销 → 仍是 200（不报 404）", againHttp.status, 200);
chk("重复注销：计数全 0", againHttp.body.data.deleted, ZERO);
chk("重复注销：userId 不变", againHttp.body.data.userId, alice.uid);

// --- 3.4 不受停机闸门影响 ---
// 开停机并发布，然后确认：普通写接口被拦，注销照常放行。
const carol = await newAccount();
await call("PUT", "/api/game/save", { token: carol.token, body: SAVE(333) });
await call("PUT", "/api/admin/ops/ops", { adminKey: ADMIN_KEY, body: { maintenance: true, maintenanceMessage: "测试停机", maintenanceEta: "", maintenanceAllowUids: [] } });
await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });

const blockedWrite = await call("PUT", "/api/game/save", { token: carol.token, body: SAVE(999) });
chk("停机中：普通写接口 → 503", blockedWrite.status, 503);

const deleteDuringMaintenance = await call("DELETE", "/api/account", { token: carol.token });
chk("🔴 停机中：注销仍然放行 → 200", deleteDuringMaintenance.status, 200);
chkTrue("停机中注销确实删了数据", deleteDuringMaintenance.body.data.deleted.users === 1);
const carolAfter = await call("GET", "/api/game/save", { token: carol.token });
chk("停机中注销后存档确实没了", carolAfter.body.data.exists, false);

// 收尾：把停机关掉并发布，别把状态留给下一个用例（虽然各测试用独立进程）
await call("PUT", "/api/admin/ops/ops", { adminKey: ADMIN_KEY, body: { maintenance: false, maintenanceMessage: "", maintenanceEta: "", maintenanceAllowUids: [] } });
await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });

// --- 3.5 路由注册顺序（别被通配路由截走）---
{
  const fs = await import("node:fs");
  const source = fs.readFileSync(path.join(API_DIR, "server.js"), "utf8");
  const lines = source.split(/\r?\n/);

  // ⚠️ 必须逐行扫真实注册行。直接 indexOf 会命中 server.js 里那句提示注释
  //    `// ⚠️ 路由必须注册在 \`app.post("/api/admin/:type")\` 之前` —— 注释在
  //    第 481 行、真实注册在第 1600 行，indexOf 拿到的是注释位置，断言恒 FAIL。
  const lineOf = needle => {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (t.startsWith(needle)) return i + 1;
    }
    return -1;
  };

  const at = lineOf('app.delete("/api/account"');
  const wildcard = lineOf('app.post("/api/admin/:type"');
  const adminGuard = lineOf('app.use("/api/admin"');
  chkTrue("DELETE /api/account 已注册", at > 0);
  chkTrue("注册在 /api/admin/:type 通配之前", at > 0 && wildcard > 0 && at < wildcard);
  chkTrue("注册在 /api/admin 管理鉴权中间件之后（顺序符合惯例）", adminGuard > 0 && at > adminGuard);
  chkTrue("路径不带 /api/admin 前缀 → 不会被管理鉴权拦截", !"/api/account".startsWith("/api/admin"));

  // 🔴 真正会被截走的情形是「同方法 + 路径能匹配」。逐条列出全站 DELETE 路由，
  //    确认没有哪条能匹配到单段的 /api/account（`/api/admin/:type/:id` 是三段，不冲突）。
  const deletePaths = lines
    .map(l => l.trim())
    .filter(t => !t.startsWith("//") && t.startsWith("app.delete("))
    .map(t => (t.match(/^app\.delete\("([^"]+)"/) || [])[1])
    .filter(Boolean);
  chkTrue("全站 DELETE 路由已列出", deletePaths.length >= 2);
  chkTrue("🔴 没有 DELETE 通配能截走 /api/account",
    deletePaths.filter(p => p.includes(":")).every(p => p.split("/").filter(Boolean).length >= 3));
  chkTrue("DELETE /api/account 是精确路径（无参数段）", deletePaths.includes("/api/account"));
}

server.kill();
console.log(`\n===== account-delete: PASS=${pass} FAIL=${fail} =====`);
if (fail > 0) { console.log("\n服务日志：\n" + logs.slice(-3000)); process.exit(1); }
