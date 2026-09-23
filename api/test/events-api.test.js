// 事件配置类型的 HTTP 层回归测试（F6 / F7）。
//
// 证明三件事：
//   1. `events` 已经注册进 server.js 的 types —— 否则后台 CRUD 全是 404，事件系统根本没法配；
//   2. 保存时走 validateEventConfig：handler 不在白名单 / 概率越界必须在写库前就被拦住；
//   3. 公开接口 /api/game/events 只下发已发布的事件（草稿不能提前生效）。
//
// 反向验证：把 server.js 的 types 里去掉 "events"，本测试会 FAIL（CRUD 变 404）。
//
// 跑法：node test/events-api.test.js
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fa-events-"));
const PORT = 8142;
process.env.UPLOAD_DIR = UPLOAD_DIR;
process.env.PORT = String(PORT);
process.env.EXTRA_PORTS = "0";
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-events";
delete process.env.CLOUDBASE_ENV_ID; // 走内存仓库

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method, headers: { "content-type": "application/json", ...headers } },
      res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const auth = { "x-admin-key": "test-admin-key-events" };
const json = text => { try { return JSON.parse(text || "{}"); } catch { return {}; } };

console.log("--- 启动服务 ---");
const server = await import("../server.js");
const { createMemoryRepository } = await import("../repository.js");
server.setRepositoryForTest(createMemoryRepository());
await server.startServer();

console.log("\n--- 后台读取种子事件 ---");
const adminList = json((await request("GET", "/api/admin/events", null, auth)).body);
chk("GET /api/admin/events -> 200 且有数据", Array.isArray(adminList.data) && adminList.data.length > 0, true);
chk("种子里 4 个事件都在（3 在线 + 1 离线）", (adminList.data || []).length, 4);

console.log("\n--- 保存校验：不合法的配置必须被拦在写库之前 ---");
const base = {
  id: "t-escape",
  name: "测试事件",
  description: "",
  message: "测试文案 {name}",
  enabled: true,
  eventType: "online",
  handler: "fish-escape",
  params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 },
  relatedTag: "",
  probability: 0.01,
  checkIntervalSeconds: 300,
  cooldownMinutes: 720,
  maxPerDay: 1,
  conditions: { minFish: 2, minBubbles: 0, hasTag: "" }
};
const badHandler = await request("POST", "/api/admin/events", { ...base, handler: "run-arbitrary-code" }, auth);
chk("handler 不在白名单 -> 400", badHandler.status, 400);
chk("400 的错误信息说清了原因", /handler/.test(json(badHandler.body).error || ""), true);

const badProbability = await request("POST", "/api/admin/events", { ...base, id: "t-bad-p", probability: 1.8 }, auth);
chk("probability 越界 -> 400", badProbability.status, 400);

const badTreasure = await request("POST", "/api/admin/events", { ...base, id: "t-bad-t", handler: "treasure", relatedTag: "" }, auth);
chk("treasure 缺 relatedTag -> 400", badTreasure.status, 400);

// F11：离线事件不需要检测间隔（它是按「再次进入」结算的），不该被校验拦下
const offlineDraft = { ...base, id: "t-offline", eventType: "offline", handler: "give-bubbles", params: { min: 8, max: 24, maxOfflineHours: 24 }, probability: 0.3 };
delete offlineDraft.checkIntervalSeconds;
const offlineCreated = await request("POST", "/api/admin/events", offlineDraft, auth);
chk("离线事件不填 checkIntervalSeconds -> 201", offlineCreated.status, 201);
await request("DELETE", "/api/admin/events/t-offline", null, auth);

// 但离线事件仍然要过 probability 的范围检查
const offlineBadProbability = await request("POST", "/api/admin/events", { ...offlineDraft, id: "t-offline-bad", probability: 0 }, auth);
chk("离线事件 probability 为 0 -> 400", offlineBadProbability.status, 400);

console.log("\n--- 保存 / 发布 / 公开下发 ---");
const created = await request("POST", "/api/admin/events", base, auth);
chk("合法事件 -> 201", created.status, 201);
const createdId = json(created.body).data?.id;
chk("id 取自 data.id", createdId, "t-escape");

// 草稿不能下发到玩家端
const gameBeforePublish = json((await request("GET", "/api/game/events")).body);
chk("未发布的事件不出现在公开接口", (gameBeforePublish.data || []).some(record => record.id === "t-escape"), false);

const published = await request("POST", "/api/admin/events/t-escape/publish", null, auth);
chk("发布 -> 200", published.status, 200);

const gameAfterPublish = json((await request("GET", "/api/game/events")).body);
const publicEvent = (gameAfterPublish.data || []).find(record => record.id === "t-escape");
chk("发布后出现在公开接口", Boolean(publicEvent), true);
chk("公开接口下发的是 publishedData", publicEvent && publicEvent.data && publicEvent.data.handler, "fish-escape");
chk("公开接口带上了 params（玩家端 handler 要用）", publicEvent && publicEvent.data && publicEvent.data.params && publicEvent.data.params.minSurvivalMinutes, 1440);

console.log("\n--- 修改 / 删除 ---");
const updated = await request("PUT", "/api/admin/events/t-escape", { ...base, maxPerDay: 2 }, auth);
chk("PUT -> 200", updated.status, 200);
const afterUpdate = json((await request("GET", "/api/admin/events", null, auth)).body).data.find(record => record.id === "t-escape");
chk("修改已落库", afterUpdate && afterUpdate.data && afterUpdate.data.maxPerDay, 2);
chk("修改后变成未发布（草稿）", afterUpdate && afterUpdate.published, false);

const removed = await request("DELETE", "/api/admin/events/t-escape", null, auth);
chk("DELETE -> 204", removed.status, 204);
const afterDelete = json((await request("GET", "/api/admin/events", null, auth)).body).data.find(record => record.id === "t-escape");
chk("删除后列表里没有了", afterDelete, undefined);

console.log("\n----");
console.log(`events-api.test: PASS=${pass} FAIL=${fail}`);
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
