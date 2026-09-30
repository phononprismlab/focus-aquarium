// 运营奖励（发放 + 结算）的回归测试。
//
// 这个文件盯的是**经济安全**，不是「接口能返回 200」。四件事：
//   1) 叠加顺序：奖励必须在 mergeSaveForWrite **之后**叠加。先加再 merge 会被
//      客户端更小的泡泡值夹掉 —— 这是本功能最容易返工的一个坑。
//   2) 发放校验：物品 id 必须在**已发布配置**里存在，否则玩家存档里会出现幽灵物品。
//   3) 幂等与并发：同一批奖励并发结算只能发一次。
//   4) 兜底结算：push 存档时自动结算，玩家端不需要额外动作也能拿到奖励。
//
// 全程自造 RSA 私钥 + 内存仓库/内存玩家数据层，不连任何云环境。
// 运行：node test/grants.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(here, "..");
const PORT = 4901;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = "grants-test-key-0123456789ab";

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

const {
  createMemoryPlayerStore, applyGrants, normalizeGrantItems, parseGrantItems, serializeGrantItems,
  GRANT_BUBBLES_MAX, GRANT_QTY_MAX, MAX_BUBBLES
} = await import("../player-store.js");

// ===== 1. items 的形状校验 =====
console.log("\n--- 1. items 形状校验（后台传什么都不能把坏数据写进库存）---");
chk("缺省 = 空数组", normalizeGrantItems(undefined), { ok: true, items: [] });
chkTrue("不是数组 → 拒", normalizeGrantItems({ id: "fish001" }).ok === false);
chkTrue("缺 id → 拒", normalizeGrantItems([{ category: "fish", qty: 1 }]).ok === false);
chkTrue("分类不合法 → 拒", normalizeGrantItems([{ id: "fish001", category: "fishs", qty: 1 }]).ok === false);
chkTrue("数量是 0 → 拒", normalizeGrantItems([{ id: "fish001", category: "fish", qty: 0 }]).ok === false);
chkTrue("数量是负数 → 拒", normalizeGrantItems([{ id: "fish001", category: "fish", qty: -2 }]).ok === false);
chkTrue(`数量超上限（${GRANT_QTY_MAX}）→ 拒`, normalizeGrantItems([{ id: "fish001", category: "fish", qty: GRANT_QTY_MAX + 1 }]).ok === false);
chk("同一件物品写两次 → 合并成一条",
  normalizeGrantItems([{ id: "fish001", category: "fish", qty: 1 }, { id: "fish001", category: "fish", qty: 2 }]).items,
  [{ id: "fish001", category: "fish", qty: 3 }]);
chk("正常一条 → 原样通过",
  normalizeGrantItems([{ id: "decoration001", category: "decorations", qty: 1 }]).items,
  [{ id: "decoration001", category: "decorations", qty: 1 }]);

console.log("\n--- 1b. items 的存取（库里是 JSON 文本）---");
chk("空数组存成空串（与 schema 的 DEFAULT '' 对齐）", serializeGrantItems([]), "");
chk("非空存成 JSON 文本", serializeGrantItems([{ id: "a", category: "fish", qty: 1 }]), '[{"id":"a","category":"fish","qty":1}]');
chk("空串读成空数组", parseGrantItems(""), []);
chk("坏 JSON 读成空数组（不炸掉结算）", parseGrantItems("{不是 JSON"), []);
chk("对象（不是数组）也读成空数组", parseGrantItems('{"id":"a"}'), []);
chk("内存实现直接给数组时原样返回", parseGrantItems([{ id: "a" }]), [{ id: "a" }]);

// ===== 2. applyGrants 纯函数 =====
console.log("\n--- 2. 叠加：泡泡累加、物品入库存 ---");
const baseSave = bubbles => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: {}, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});
{
  const out = applyGrants(baseSave(100), [{ bubbles: 500, items: "" }]);
  chk("泡泡 100 + 500 = 600", out.save.PlayerData.bubbles, 600);
  chk("到手明细里的泡泡 = 500", out.bubbles, 500);
  chk("余额 = 600", out.balance, 600);
  chk("changed = true", out.changed, true);
}
{
  const out = applyGrants(baseSave(100), [{
    bubbles: 0,
    items: JSON.stringify([{ id: "fish001", category: "fish", qty: 2 }, { id: "sand001", category: "sands", qty: 1 }])
  }]);
  chk("物品进对应分类的库存", out.save.PlayerData.inventory.fish.fish001, 2);
  chk("跨分类也要落对位置", out.save.PlayerData.inventory.sands.sand001, 1);
  chk("明细按件列出", out.items, [{ id: "fish001", category: "fish", qty: 2 }, { id: "sand001", category: "sands", qty: 1 }]);
  chk("没发泡泡就不动泡泡", out.save.PlayerData.bubbles, 100);
}
{
  const out = applyGrants(baseSave(100), []);
  chk("空批次 → changed:false（调用方据此跳过写库）", out.changed, false);
  chk("空批次 → 存档引用不变", out.save.PlayerData.bubbles, 100);
}
{
  // 脏数据：分类不在白名单里的条目直接跳过，不能污染库存。
  const out = applyGrants(baseSave(100), [{ bubbles: 10, items: JSON.stringify([{ id: "x", category: "没这个分类", qty: 1 }]) }]);
  chk("非法分类的条目被跳过", Object.keys(out.save.PlayerData.inventory.fish).length, 0);
  chk("同一批里的泡泡照发", out.bubbles, 10);
}
{
  const out = applyGrants(baseSave(MAX_BUBBLES), [{ bubbles: 500 }]);
  chk("泡泡封顶在 MAX_BUBBLES", out.save.PlayerData.bubbles, MAX_BUBBLES);
  chk("到手明细用**实际差额**（0）而不是名义的 500", out.bubbles, 0);
}
{
  // 首次同步的存档可能没有 PlayerData —— 不能因此抛异常。
  const out = applyGrants(null, [{ bubbles: 10 }]);
  chk("存档为 null 也能叠加（按空存档算）", out.save.PlayerData.bubbles, 10);
}

// ===== 3. 内存 store 的 grants 方法 =====
console.log("\n--- 3. 双 store 约定：内存实现也要有 grants ---");
{
  const store = createMemoryPlayerStore({ now: () => 1000 });
  await store.addGrants([
    { id: "g1", user_id: "u_a", bubbles: 10, items: "", reason: "r", created_at: 1 },
    { id: "g2", user_id: "u_b", bubbles: 20, items: "", reason: "r", created_at: 2 }
  ]);
  chk("列表能查到 2 条", (await store.listGrants({})).length, 2);
  chk("按 user 过滤", (await store.listGrants({ userId: "u_a" })).map(g => g.id), ["g1"]);
  chk("新发放默认未领取", (await store.listGrants({ userId: "u_a" }))[0].claimed_at, 0);

  chk("认领只拿自己的", (await store.claimPendingGrants("u_a", { at: 500 })).map(g => g.id), ["g1"]);
  chk("同一批再认领 → 空（幂等）", (await store.claimPendingGrants("u_a", { at: 600 })), []);
  chk("认领后列表里已标记", (await store.listGrants({ userId: "u_a" }))[0].claimed_at, 500);
  chk("别人的奖励没被动", (await store.listGrants({ userId: "u_b" }))[0].claimed_at, 0);

  chk("退回：claimed_at 不匹配 → 不退", await store.releaseGrants(["g1"], { claimedAt: 999 }), 0);
  chk("退回：匹配 → 退 1 条", await store.releaseGrants(["g1"], { claimedAt: 500 }), 1);
  chk("退回后又能被认领", (await store.claimPendingGrants("u_a", { at: 700 })).map(g => g.id), ["g1"]);
  chk("_sizes 暴露 grants 条数", store._sizes().grants, 2);
}

// ===== 4. 起服务：HTTP 层 =====
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDS = Buffer.from(JSON.stringify({
  private_key_id: "grants-key-id-0001", private_key: privateKey, env_id: "grants-env-0001"
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
  const h = { "content-type": "application/json" };
  if (opts.token) h.authorization = `Bearer ${opts.token}`;
  if (opts.adminKey) h["x-admin-key"] = opts.adminKey;
  const r = await fetch(BASE + p, {
    method, headers: h,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const newAccount = async () => {
  const r = await call("POST", "/api/account/ticket", { body: {} });
  return { uid: r.body.data.uid, token: r.body.data.token };
};
const SAVE = bubbles => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: {}, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});
const grant = (body, mode = "apply") => call("POST", "/api/admin/grants", {
  adminKey: ADMIN_KEY, body: { ...body, mode }
});

try {
  // ===== 5. 后台发放接口的校验 =====
  console.log("\n--- 5. 后台发放：门禁与校验 ---");
  const acc = await newAccount();
  await call("PUT", "/api/game/save", { token: acc.token, body: SAVE(100) });

  chk("没有管理密钥 → 401", (await call("POST", "/api/admin/grants", { body: { userIds: [acc.uid], bubbles: 1, reason: "x" } })).status, 401);
  chk("缺 userIds → 400", (await grant({ bubbles: 10, reason: "补偿" })).status, 400);
  chk("缺 reason → 400", (await grant({ userIds: [acc.uid], bubbles: 10 })).status, 400);
  chk("泡泡和物品都没有 → 400", (await grant({ userIds: [acc.uid], reason: "补偿" })).status, 400);
  chk("泡泡超单次上限 → 400", (await grant({ userIds: [acc.uid], bubbles: GRANT_BUBBLES_MAX + 1, reason: "补偿" })).status, 400);
  {
    const r = await grant({ userIds: [acc.uid], bubbles: 1, reason: "补偿", items: [{ id: "不存在的物品", category: "fish", qty: 1 }] });
    chk("物品不在已发布配置里 → 400", r.status, 400);
    chkTrue("报错点名是哪个物品", String(r.body.error || "").includes("不在已发布配置"), r.body.error);
  }
  {
    const r = await grant({ userIds: [acc.uid], bubbles: 1, reason: "补偿", items: [{ id: "decoration001", category: "fish", qty: 1 }] });
    chk("物品分类与配置不一致 → 400（不采信后台提交的分类）", r.status, 400);
  }

  // ===== 6. 干跑 / 真发 =====
  console.log("\n--- 6. 默认干跑：先看清楚发给谁，再决定发 ---");
  {
    const dry = await grant({ userIds: [acc.uid, "u_没这个人"], bubbles: 500, reason: "维护补偿" }, "dry-run");
    chk("干跑 → 200", dry.status, 200);
    chk("干跑标记 applied:false", dry.body.data.applied, false);
    chk("干跑列出真正的收件人", dry.body.data.targets.map(t => t.userId), [acc.uid]);
    chk("未注册的 uid 进 skipped 而不是整批失败", dry.body.data.skipped.map(s => s.userId), ["u_没这个人"]);
    chk("干跑不落库", (await call("GET", `/api/admin/grants?userId=${acc.uid}`, { adminKey: ADMIN_KEY })).body.data.count, 0);
  }
  {
    const items = [{ id: "decoration001", category: "decorations", qty: 1 }];
    const applied = await grant({ userIds: [acc.uid], bubbles: 500, reason: "维护补偿", items });
    chk("真发 → 200", applied.status, 200);
    chk("真发标记 applied:true", applied.body.data.applied, true);
    chk("返回发放记录条数 = 1", applied.body.data.grants.length, 1);
    const list = await call("GET", `/api/admin/grants?userId=${acc.uid}`, { adminKey: ADMIN_KEY });
    chk("列表能查到", list.body.data.count, 1);
    chk("初始状态未领取", list.body.data.grants[0].claimed, false);
    chk("泡泡数落库", list.body.data.grants[0].bubbles, 500);
    chk("物品落库（分类由服务端从配置读出）", list.body.data.grants[0].items, items);
    chk("理由落库", list.body.data.grants[0].reason, "维护补偿");
  }

  // ===== 7. 兜底结算：push 存档时自动结算 =====
  console.log("\n--- 7. push 兜底结算（玩家端不需要额外动作）---");
  {
    // 玩家本地还是 100（他不知道有奖励），推上来 —— 这一推必须把奖励结算进去。
    const pushed = await call("PUT", "/api/game/save", { token: acc.token, body: SAVE(100) });
    chk("推送 → 200", pushed.status, 200);
    const data = pushed.body.data;
    chk("响应里带上本次结算的奖励", Boolean(data.claimedGrants), true);
    chk("结算的泡泡数 = 500", data.claimedGrants.bubbles, 500);
    chk("结算后余额 = 600", data.claimedGrants.balance, 600);
    chk("🔴 返回的存档里泡泡 = 600（玩家端据此覆盖本地）", data.save.PlayerData.bubbles, 600);
    chk("🔴 叠加在 merge 之后：客户端提交的 100 没有把奖励夹掉", data.save.PlayerData.bubbles, 600);
    chk("物品也进了库存", data.save.PlayerData.inventory.decorations.decoration001, 1);
    chk("理由带到小票上", data.claimedGrants.reasons, ["维护补偿"]);

    const list = await call("GET", `/api/admin/grants?userId=${acc.uid}`, { adminKey: ADMIN_KEY });
    chk("后台列表里已标记为已领取", list.body.data.grants[0].claimed, true);
    chkTrue("领取时间是真实毫秒时间戳", Number(list.body.data.grants[0].claimedAt) > 1_600_000_000_000, String(list.body.data.grants[0].claimedAt));
  }
  {
    // 再推一次：这次没有待领取的奖励，不该重复发。
    const again = await call("PUT", "/api/game/save", { token: acc.token, body: SAVE(600) });
    chk("没有待领取时 claimedGrants 为 null", again.body.data.claimedGrants, null);
    chk("泡泡保持 600（不会重复发放）", again.body.data.save.PlayerData.bubbles, 600);
  }
  {
    // 🔴 这条断言守的是**玩家端契约**：结算返回的存档必须被采用。
    //    继续推旧的小泡泡值会把奖励抹掉 —— 这是「泡泡是客户端权威」的已知边界
    //    （购买后本来就要推更小值，所以服务端不能拒绝更小的值）。
    //    如果哪天把泡泡也收归服务端权威，这条断言会翻转，届时请连带更新这一段注释。
    const stale = await call("PUT", "/api/game/save", { token: acc.token, body: SAVE(100) });
    chk("🔴 已知边界：不采用结算返回值、继续推旧值 → 奖励被覆盖", stale.body.data.save.PlayerData.bubbles, 100);
    await call("PUT", "/api/game/save", { token: acc.token, body: SAVE(600) }); // 复原，别影响后面的用例
  }

  // ===== 8. 主动结算接口 =====
  console.log("\n--- 8. POST /api/game/grants/claim ---");
  {
    const acc2 = await newAccount();
    await call("PUT", "/api/game/save", { token: acc2.token, body: SAVE(50) });
    await grant({ userIds: [acc2.uid], bubbles: 200, reason: "补偿" });

    const claim = await call("POST", "/api/game/grants/claim", { token: acc2.token });
    chk("结算 → 200", claim.status, 200);
    chk("余额 50 + 200 = 250", claim.body.data.save.PlayerData.bubbles, 250);
    chk("小票泡泡 = 200", claim.body.data.receipt.bubbles, 200);
    chk("返回 updatedAt（玩家端 markPushed 用）", Number(claim.body.data.updatedAt) > 0, true);

    const empty = await call("POST", "/api/game/grants/claim", { token: acc2.token });
    chk("没有待领取时 receipt 为 null", empty.body.data.receipt, null);
    chk("泡泡不变", empty.body.data.save, null);
  }
  {
    // 未登录不能领。
    chk("没有令牌 → 401", (await call("POST", "/api/game/grants/claim", {})).status, 401);
  }
  {
    // 还没有云存档：奖励留着，不能凭空建一份空存档把玩家的鱼缸抹掉。
    const acc3 = await newAccount();
    await grant({ userIds: [acc3.uid], bubbles: 300, reason: "补偿" });
    const claim = await call("POST", "/api/game/grants/claim", { token: acc3.token });
    chk("没有云存档 → 200 且 pending:true", claim.body.data.pending, true);
    chk("没有云存档时不写存档", claim.body.data.save, null);
    const list = await call("GET", `/api/admin/grants?userId=${acc3.uid}`, { adminKey: ADMIN_KEY });
    chk("🔴 奖励被退回未领取（不会永久卡住）", list.body.data.grants[0].claimed, false);

    // 玩家同步一次 —— push 本身就是兜底结算入口，所以这一推就把奖励结算进去了。
    const pushed = await call("PUT", "/api/game/save", { token: acc3.token, body: SAVE(0) });
    chk("同步（push）就把退回的奖励重新结算进去了", pushed.body.data.claimedGrants.bubbles, 300);
    chk("余额 = 300", pushed.body.data.save.PlayerData.bubbles, 300);
    const after = await call("POST", "/api/game/grants/claim", { token: acc3.token });
    chk("push 已经结算过，claim 拿到空结果（两条入口不会重复发）", after.body.data.receipt, null);
  }

  // ===== 9. 并发：同一批奖励只能发一次 =====
  console.log("\n--- 9. 并发结算（幂等）---");
  {
    const acc4 = await newAccount();
    await call("PUT", "/api/game/save", { token: acc4.token, body: SAVE(0) });
    await grant({ userIds: [acc4.uid], bubbles: 1000, reason: "补偿" });

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      call("POST", "/api/game/grants/claim", { token: acc4.token })));
    const codes = {};
    for (const r of results) codes[r.status] = (codes[r.status] || 0) + 1;
    console.log(`   状态分布 = ${JSON.stringify(codes)}`);
    chk("没有 500", codes[500] || 0, 0);

    const totalGranted = results.reduce((sum, r) => sum + Number((r.body.data.receipt || {}).bubbles || 0), 0);
    chk("🔴 5 个并发请求合计只发出 1000（不是 5000）", totalGranted, 1000);
    const save = (await call("GET", "/api/game/save", { token: acc4.token })).body.data.save;
    chk("最终余额 = 1000", save.PlayerData.bubbles, 1000);
  }

  // ===== 10. 停机闸门 =====
  console.log("\n--- 10. 停机时不能结算（写接口一律挡住）---");
  {
    const acc5 = await newAccount();
    await call("PUT", "/api/game/save", { token: acc5.token, body: SAVE(0) });
    await grant({ userIds: [acc5.uid], bubbles: 10, reason: "补偿" });

    await call("PUT", "/api/admin/ops/ops", { adminKey: ADMIN_KEY, body: { maintenance: true, maintenanceMessage: "维护中", maintenanceAllowUids: [] } });
    await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });
    const blocked = await call("POST", "/api/game/grants/claim", { token: acc5.token });
    chk("停机时结算 → 503", blocked.status, 503);
    chk("响应里带 maintenance:true（玩家端据此切维护页）", blocked.body.maintenance, true);
    const list = await call("GET", `/api/admin/grants?userId=${acc5.uid}`, { adminKey: ADMIN_KEY });
    chk("停机挡下后奖励仍未领取（没被吃掉）", list.body.data.grants[0].claimed, false);

    // 关掉停机，确认恢复正常（也顺便验证闸门不是「一旦打开就再也关不掉」）。
    await call("PUT", "/api/admin/ops/ops", { adminKey: ADMIN_KEY, body: { maintenance: false, maintenanceMessage: "", maintenanceAllowUids: [] } });
    await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });
    const ok = await call("POST", "/api/game/grants/claim", { token: acc5.token });
    chk("关掉停机后能结算", ok.body.data.receipt.bubbles, 10);
  }

  // ===== 11. 多收件人一次发放 =====
  console.log("\n--- 11. 一次发给多个人 ---");
  {
    const a = await newAccount();
    const b = await newAccount();
    const r = await grant({ userIds: [a.uid, b.uid], bubbles: 77, reason: "集体补偿" });
    chk("两个人都发了", r.body.data.grants.length, 2);
    chk("两个人的 uid 都在", r.body.data.grants.map(g => g.userId).sort(), [a.uid, b.uid].sort());
    const listA = await call("GET", `/api/admin/grants?userId=${a.uid}`, { adminKey: ADMIN_KEY });
    chk("各自一条记录", listA.body.data.count, 1);
  }
} catch (error) {
  console.log(`\n测试中途抛异常：${error.stack || error.message}`);
  fail++;
} finally {
  server.kill();
}

console.log(`\n===== grants: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
