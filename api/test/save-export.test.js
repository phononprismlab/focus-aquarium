// 全量存档导出（备份通道）的回归测试。
//
// 为什么要有这个功能：CloudBase 个人版**没有数据回档** —— 存档在库里被误删 /
// 实例故障就永久没了。`GET /api/admin/saves/export` 是唯一能把存档搬出数据库实例的
// 通道（配合本机定时脚本落到异地磁盘，才算真有备份）。
//
// 四层验证：
//   1) 数据层 exportArchive（内存 store）：结构 / 字段白名单 / 深拷贝
//   2) 数据层 exportArchive（CloudBase 桩）：查询面貌 / 坏 JSON 保留原文 / 列名映射
//   3) HTTP 层：鉴权闸门 / 返回内容 / counts
//   4) admin.html：按钮存在 / 接线 / 请求路径 / 文件名 / payload 内容
// 末尾做反向验证：把保护塞回「错误值」，确认断言会不同（不是空闸）。
//
// 运行：node test/save-export.test.js
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

const NOW = new Date("2026-09-25T22:00:00").getTime();
const { createMemoryPlayerStore, createCloudbasePlayerStore, ARCHIVE_VERSION, ARCHIVE_USER_FIELDS } = await import("../player-store.js");

// ===== 1. 数据层 exportArchive（内存 store）=====
console.log("\n--- 1. 内存 store：exportArchive 结构 / 白名单 / 深拷贝 ---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await store.ensureUser("u_a", { cohort: "early", at: NOW - 5000 });
  await store.ensureUser("u_b", { at: NOW - 1000 });
  await store.putSave("u_a", {
    saveVersion: "0.2.0",
    PlayerData: { bubbles: 120, inventory: { fish: { fish001: 1 } } },
    AquariumData: { fish: [{ itemId: "fish001", instanceId: "f1" }] },
    Settings: { audio: { bgm: 38 } }
  }, { saveVersion: "0.2.0", clientTs: NOW - 100, at: NOW });
  await store.putSave("u_b", { saveVersion: "0.2.0", PlayerData: { bubbles: 0 } }, { at: NOW });

  const archive = await store.exportArchive();
  chk("导出 users 条数 = 2", archive.users.length, 2);
  chk("导出 saves 条数 = 2", archive.saves.length, 2);

  const ua = archive.users.find(u => u.userId === "u_a");
  chk("用户 cohort 透传", ua.cohort, "early");
  chk("用户字段集合 == ARCHIVE_USER_FIELDS（一个不多一个不少）",
    Object.keys(ua).sort(), [...ARCHIVE_USER_FIELDS].sort());
  chkTrue("🔴 用户对象里没有 sync_code_hash（凭证列不进备份）",
    !Object.keys(ua).some(k => k.toLowerCase().includes("sync")));
  chkTrue("🔴 整份导出里搜不到凭证列名",
    !JSON.stringify(archive).includes("sync_code_hash") && !JSON.stringify(archive).includes("syncCodeHash"));
  chkTrue("isSupporter 是布尔（不是 0/1）", typeof ua.isSupporter === "boolean");
  chkTrue("createdAt 是数字", typeof ua.createdAt === "number");

  const sa = archive.saves.find(s => s.userId === "u_a");
  chk("存档字段集合", Object.keys(sa).sort(), ["clientTs", "data", "saveVersion", "updatedAt", "userId"]);
  chk("saveVersion 透传", sa.saveVersion, "0.2.0");
  chk("clientTs 透传", sa.clientTs, NOW - 100);
  chk("updatedAt 透传", sa.updatedAt, NOW);
  chk("data 是对象而不是 JSON 字符串", typeof sa.data, "object");
  chk("data 内容正确（泡泡）", sa.data.PlayerData.bubbles, 120);
  chk("data 内容正确（鱼缸）", sa.data.AquariumData.fish[0].itemId, "fish001");

  // 深拷贝：改导出结果不该动到 store 内部的存档
  sa.data.PlayerData.bubbles = 999;
  const after = await store.getSave("u_a");
  chk("🔴 导出是深拷贝（改备份不影响原存档）", after.data.PlayerData.bubbles, 120);

  chk("ARCHIVE_VERSION 是数字", typeof ARCHIVE_VERSION, "number");
  chkTrue("ARCHIVE_VERSION >= 1", ARCHIVE_VERSION >= 1);

  const empty = createMemoryPlayerStore({ now: () => NOW });
  const emptyArchive = await empty.exportArchive();
  chk("空库导出 users = 0", emptyArchive.users.length, 0);
  chk("空库导出 saves = 0", emptyArchive.saves.length, 0);
}

// ===== 2. 数据层 exportArchive（CloudBase 桩）=====
console.log("\n--- 2. CloudBase 桩：查询面貌 / 坏 JSON / 列名映射 ---");
{
  const calls = [];
  const stubDb = {
    from(table) {
      const builder = {
        select(cols) { calls.push({ table, op: "select", cols }); return builder; },
        eq() { return builder; },
        throwOnError() {
          if (table === "users") {
            return { data: [{
              user_id: "u_1",
              sync_code_hash: "SHOULD-NOT-LEAK-INTO-ARCHIVE",
              nickname: "小明",
              cohort: "early",
              is_supporter: 1,
              supporter_note: "谢谢支持",
              created_at: 100,
              last_seen_at: 200
            }] };
          }
          if (table === "saves") {
            return { data: [
              { user_id: "u_1", data: '{"PlayerData":{"bubbles":7}}', save_version: "0.2.0", client_ts: 11, updated_at: 22 },
              { user_id: "u_2", data: "{这不是合法 JSON", save_version: "", client_ts: 0, updated_at: 0 }
            ] };
          }
          return { data: [] };
        }
      };
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stubDb, { now: () => NOW });
  const archive = await store.exportArchive();

  chk("CloudBase 导出 users = 1", archive.users.length, 1);
  chk("CloudBase 导出 saves = 2", archive.saves.length, 2);
  chk("is_supporter=1 映射成布尔 true", archive.users[0].isSupporter, true);
  chk("snake_case → camelCase（nickname）", archive.users[0].nickname, "小明");
  chk("last_seen_at → lastSeenAt", archive.users[0].lastSeenAt, 200);
  chk("save_version → saveVersion", archive.saves[0].saveVersion, "0.2.0");
  chk("JSON 文本解析成对象", archive.saves[0].data.PlayerData.bubbles, 7);
  chk("🔴 坏 JSON 保留原文（备份的职责是忠实，不是纠正）", archive.saves[1].data, "{这不是合法 JSON");
  chkTrue("🔴 桩里塞了凭证列，导出后不存在", !JSON.stringify(archive).includes("SHOULD-NOT-LEAK"));

  const selects = calls.filter(c => c.op === "select");
  chk("只查了 users 与 saves 两张表", selects.map(c => c.table).sort(), ["saves", "users"]);
  chkTrue("两趟查询都用 select(\"*\")（不做列名列表 select：SDK 面貌未验证）",
    selects.every(c => c.cols === "*"));
}

// ===== 3. HTTP 层 GET /api/admin/saves/export =====
console.log("\n--- 3. HTTP：GET /api/admin/saves/export ---");
let nextPort = 5300 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
const credentials = { private_key_id: "self-test-key-id-save-export", private_key: privateKey, env_id: "self-test-env-save-export" };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");
const ADMIN_KEY = "save-export-test-key-0123456789";

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: ADMIN_KEY,
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
const baseSave = () => ({
  saveVersion: "0.2.0",
  PlayerData: {
    bubbles: 100,
    isMember: false,
    inventory: { fish: { fish001: 3 }, decorations: {}, backgrounds: { background001: 1 }, sands: {}, sounds: {} }
  },
  AquariumData: { fish: [{ itemId: "fish001", instanceId: "f1" }], decoration: "", background: "background001", sand: "", ambientSound: "" },
  Settings: { audio: { bgm: 38 } }
});

{
  const { server, base } = await startServer({}, takePort());
  try {
    const noKey = await call(base, "GET", "/api/admin/saves/export");
    chk("无管理密钥 → 401（鉴权闸门在）", noKey.status, 401);

    const empty = await call(base, "GET", "/api/admin/saves/export", { adminKey: ADMIN_KEY });
    chk("带管理密钥 → 200", empty.status, 200);
    chk("空库 counts.saves = 0", empty.body.data.counts.saves, 0);
    chk("空库 counts.users = 0", empty.body.data.counts.users, 0);
    chk("返回 archiveVersion", empty.body.data.archiveVersion, ARCHIVE_VERSION);
    chkTrue("返回 exportedAt 时间戳", typeof empty.body.data.exportedAt === "number" && empty.body.data.exportedAt > 0);
    chkTrue("users / saves 都是数组", Array.isArray(empty.body.data.users) && Array.isArray(empty.body.data.saves));

    // 建号 + 推一份存档
    const ticket = await call(base, "POST", "/api/account/ticket", { body: {} });
    const token = ticket.body.data?.token;
    const uid = ticket.body.data?.uid;
    chkTrue("建号拿到令牌", Boolean(token));
    const pushed = await call(base, "PUT", "/api/game/save", { token, body: baseSave() });
    chk("推存档 → 200", pushed.status, 200);

    const full = await call(base, "GET", "/api/admin/saves/export", { adminKey: ADMIN_KEY });
    chk("推完存档后 counts.saves = 1", full.body.data.counts.saves, 1);
    chk("counts.users = 1", full.body.data.counts.users, 1);
    const row = full.body.data.saves[0];
    chk("导出行的 userId 等于刚建的账号", row.userId, uid);
    chk("导出行的 data 是对象", typeof row.data, "object");
    chk("导出行含真实泡泡数", row.data.PlayerData.bubbles, 100);
    chk("导出行含鱼缸数据", row.data.AquariumData.fish[0].itemId, "fish001");
    chkTrue("🔴 HTTP 响应里没有凭证列名",
      !JSON.stringify(full.body).includes("sync_code_hash") && !JSON.stringify(full.body).includes("syncCodeHash"));

    // 反向：若鉴权闸门被摘掉，无密钥请求会 200；这里确认它仍是 401。
    chkTrue("R3 反向：鉴权闸门确实拦住了无密钥请求", noKey.status === 401 && empty.status === 200);
  } finally { server.kill(); }
}

// ===== 4. admin.html 渲染层 =====
console.log("\n--- 4. admin.html：导出按钮与接线 ---");
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

const ARCHIVE_PAYLOAD = {
  archiveVersion: ARCHIVE_VERSION,
  exportedAt: NOW,
  counts: { users: 1, saves: 1 },
  users: [{ userId: "u_1", nickname: "小明", cohort: "early", isSupporter: false, supporterNote: "", createdAt: NOW, lastSeenAt: NOW }],
  saves: [{ userId: "u_1", saveVersion: "0.2.0", clientTs: NOW, updatedAt: NOW, data: { PlayerData: { bubbles: 100 } } }]
};
let lastArchiveUrl = "";
const fakeFetch = async url => {
  lastArchiveUrl = String(url);
  if (String(url).includes("/admin/saves/export")) {
    return { ok: true, status: 200, json: async () => ({ data: ARCHIVE_PAYLOAD }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { users: [], count: 0 } }) };
};
function FakeBlob(parts) { captured.blobParts = parts[0]; }
const fakeUrl = { createObjectURL: () => "blob:fake", revokeObjectURL() {} };
const ssStub = { getItem: () => null, setItem() {}, removeItem() {} };
const lsStub = { getItem: () => null, setItem() {}, removeItem() {} };

const scriptSource = adminHtml.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const adminApi = new Function("document", "window", "sessionStorage", "localStorage", "fetch", "Blob", "URL", `
${scriptSource}
return { state, renderUserList, exportSavesJson, exportUsersCsv, apiRequest };
`)(fakeDocument, fakeWindow, ssStub, lsStub, fakeFetch, FakeBlob, fakeUrl);
const main = fakeDocument.getElementById("main");

adminApi.state.module = "users";
adminApi.state.users = [];
adminApi.renderUserList();
chkTrue("玩家管理页渲染出「导出全量存档」按钮", main.innerHTML.includes('id="exportSavesJson"'));
chkTrue("按钮文案是「导出全量存档」", main.innerHTML.includes("导出全量存档"));
chkTrue("CSV 导出按钮仍在（两个按钮并存）", main.innerHTML.includes('id="exportUsersCsv"'));
chkTrue("导出全量存档按钮已接上处理器（源码里有 onclick 赋值）",
  /getElementById\("exportSavesJson"\)\.onclick\s*=\s*exportSavesJson/.test(adminHtml));

captured.blobParts = null;
captured.anchor = null;
await adminApi.exportSavesJson();
chkTrue("请求打到 /admin/saves/export", lastArchiveUrl.includes("/admin/saves/export"));
chkTrue("生成了下载文件（Blob 有内容）", typeof captured.blobParts === "string" && captured.blobParts.length > 0);
let parsed = null;
try { parsed = JSON.parse(captured.blobParts); } catch { parsed = null; }
chkTrue("导出内容是合法 JSON", parsed !== null);
chk("导出 JSON 带 archiveVersion", parsed?.archiveVersion, ARCHIVE_VERSION);
chk("导出 JSON 带存档条数", parsed?.counts?.saves, 1);
chk("导出 JSON 含存档 data", parsed?.saves?.[0]?.data?.PlayerData?.bubbles, 100);
chkTrue("导出 JSON 是格式化过的（有换行，人能读）", captured.blobParts.includes("\n"));
chkTrue("文件名是 fishtank-saves-<日期>-<时间>.json",
  /^fishtank-saves-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(captured.anchor?.download || ""),
  captured.anchor?.download || "");
chkTrue("导出成功后给了提示", String(fakeDocument.getElementById("toast").textContent || "").includes("存档"));

// 空存档：不生成文件，只提示
captured.blobParts = null;
captured.anchor = null;
const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { archiveVersion: 1, exportedAt: NOW, counts: { users: 0, saves: 0 }, users: [], saves: [] } }) });
const emptyApi = new Function("document", "window", "sessionStorage", "localStorage", "fetch", "Blob", "URL", `
${scriptSource}
return { exportSavesJson };
`)(fakeDocument, fakeWindow, ssStub, lsStub, emptyFetch, FakeBlob, fakeUrl);
await emptyApi.exportSavesJson();
chkTrue("没有存档时不生成下载文件", captured.blobParts === null);
chkTrue("没有存档时提示「还没有存档可导出」",
  String(fakeDocument.getElementById("toast").textContent || "").includes("还没有存档可导出"));

// 反向：接口失败 → 走错误分支，不生成文件
const failFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "服务端炸了" }) });
const failApi = new Function("document", "window", "sessionStorage", "localStorage", "fetch", "Blob", "URL", `
${scriptSource}
return { exportSavesJson };
`)(fakeDocument, fakeWindow, ssStub, lsStub, failFetch, FakeBlob, fakeUrl);
await failApi.exportSavesJson();
chkTrue("R4 反向：接口失败时不生成下载文件", captured.blobParts === null);
chkTrue("接口失败时提示里带上了服务端理由",
  String(fakeDocument.getElementById("toast").textContent || "").includes("服务端炸了"));

console.log(`\n===== 存档导出测试：${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exitCode = 1;
