// 泡泡服务端权威的回归测试。
//
// 这个文件盯的是**经济安全**，不是「接口能返回 200」。四件事：
//   1) 客户端**只能减不能加** —— 上浮一律回落到服务端现值。
//   2) 反复 push 刷不出泡泡。旧规则是 `min(提交值, 服务端值 + 2000)`，只挡单次增量、
//      不挡次数：循环 push 每次报「当前 +2000」就是无限泡泡。这是本次修复的正题。
//   3) 🔴 服务端加上去的泡泡**不能被客户端推更小的值夹掉** —— 这是 grants 协议存在的理由，
//      也是「服务端直接写 saves.bubbles」行不通的原因。这条一旦回归，奖励会凭空蒸发。
//   4) 冷却账本（queryGrants）的语义：reason 必须精确匹配，不能被前缀串味。
//
// 全程自造 RSA 私钥 + 内存仓库/内存玩家数据层，不连任何云环境。
// 运行：node test/bubble-authority.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(here, "..");
const PORT = 4902;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = "bubble-authority-key-0123456789";

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

const { mergeSaveForWrite, createMemoryPlayerStore, FIRST_PUSH_MAX_BUBBLES, eventRewardReason, planEventReward } =
  await import("../player-store.js").then(async mod => ({
    ...mod,
    ...(await import("../event-config.js"))
  }));

const SAVE = bubbles => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: {}, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});

// ===== 1. 合并层：客户端只能减 =====
console.log("\n--- 1. 合并层：客户端只能减、不能加 ---");
{
  const stored = { PlayerData: { bubbles: 100, isMember: false, inventory: {} } };

  const up = mergeSaveForWrite(stored, { PlayerData: { bubbles: 150 } });
  chk("上浮 100→150 被拒，回落到服务端现值", up.save.PlayerData.bubbles, 100);
  chkTrue("上浮留了记录（便于排查「我明明加了怎么没生效」）",
    up.problems.some(p => p.includes("泡泡只允许服务端增加")), up.problems.join(" / "));

  const down = mergeSaveForWrite(stored, { PlayerData: { bubbles: 40 } });
  chk("下调 100→40 放行（买东西要能推更小的余额）", down.save.PlayerData.bubbles, 40);
  chkTrue("下调不记问题", !down.problems.some(p => p.includes("泡泡")), down.problems.join(" / "));

  const same = mergeSaveForWrite(stored, { PlayerData: { bubbles: 100 } });
  chk("持平放行", same.save.PlayerData.bubbles, 100);

  chk("负数是 0（不是 NaN）", mergeSaveForWrite(stored, { PlayerData: { bubbles: -5 } }).save.PlayerData.bubbles, 0);
  chk("非数字回落 0", mergeSaveForWrite(stored, { PlayerData: { bubbles: "abc" } }).save.PlayerData.bubbles, 0);

  // 首推是唯一的例外通道：玩家的真实进度只在他浏览器里，从 0 开始等于抹掉历史。
  // 但它有界 —— 这是已知且可接受的作弊面（V1.0 泡泡不对应现实价值）。
  const first = mergeSaveForWrite(null, { PlayerData: { bubbles: 999999999 } });
  chk("首次同步仍以本地为准，但封顶", first.save.PlayerData.bubbles, FIRST_PUSH_MAX_BUBBLES);
  chkTrue("首次同步标记 firstPush", first.firstPush, true);
}

// ===== 2. 冷却账本：queryGrants 的语义 =====
console.log("\n--- 2. queryGrants：事件冷却账本的语义 ---");
{
  const store = createMemoryPlayerStore({ now: () => 10_000 });
  await store.addGrants([
    { id: "g1", user_id: "u_a", bubbles: 1, items: [], reason: eventRewardReason("e1"), created_at: 1000 },
    { id: "g2", user_id: "u_a", bubbles: 1, items: [], reason: eventRewardReason("e1"), created_at: 5000 },
    // 🔴 e10 的 reason 以 "event:e1" 为前缀 —— 精确匹配必须把它排除掉，否则两个事件互相污染配额。
    { id: "g3", user_id: "u_a", bubbles: 1, items: [], reason: eventRewardReason("e10"), created_at: 6000 },
    { id: "g4", user_id: "u_b", bubbles: 1, items: [], reason: eventRewardReason("e1"), created_at: 7000 }
  ]);

  const e1 = await store.queryGrants({ userId: "u_a", reason: eventRewardReason("e1"), since: 0 });
  chk("只数本事件的行（e10 不串味）", e1.count, 2);
  chk("lastAt 取最大时间戳", e1.lastAt, 5000);

  const e1Today = await store.queryGrants({ userId: "u_a", reason: eventRewardReason("e1"), since: 2000 });
  chk("since 过滤掉旧行", e1Today.count, 1);
  chk("过滤后 lastAt 仍是窗口内的最大值", e1Today.lastAt, 5000);

  const other = await store.queryGrants({ userId: "u_b", reason: eventRewardReason("e1"), since: 0 });
  chk("只数这个用户的行", other.count, 1);

  const none = await store.queryGrants({ userId: "u_a", reason: eventRewardReason("nope"), since: 0 });
  chk("没发过 = 0 条、lastAt 0", none, { count: 0, lastAt: 0 });
}

// ===== 3. planEventReward：冷却与每日上限 =====
console.log("\n--- 3. planEventReward：服务端闸门 ---");
{
  const config = { id: "e1", enabled: true, handler: "give-bubbles", params: { min: 10, max: 30 }, cooldownMinutes: 30, maxPerDay: 3 };
  const none = { count: 0, lastAt: 0 };

  const ok = planEventReward({ config, observed: none, requested: 20, now: 1_000_000 });
  chk("正常放行", { ok: ok.ok, bubbles: ok.bubbles }, { ok: true, bubbles: 20 });
  chk("reason 精确到事件", ok.reason, eventRewardReason("e1"));

  chk("客户端报超过 max → 钳到 max",
    planEventReward({ config, observed: none, requested: 999999, now: 1_000_000 }).bubbles, 30);
  chk("客户端报低于 min → 抬到 min",
    planEventReward({ config, observed: none, requested: 1, now: 1_000_000 }).bubbles, 10);
  chk("客户端报非法值 → 按 min（保守）",
    planEventReward({ config, observed: none, requested: "abc", now: 1_000_000 }).bubbles, 10);
  chk("客户端不报 → 按 min",
    planEventReward({ config, observed: none, requested: undefined, now: 1_000_000 }).bubbles, 10);

  const cooling = planEventReward({ config, observed: { count: 1, lastAt: 990_000 }, requested: 20, now: 1_000_000 });
  chk("冷却中 → 拒", cooling.code, "COOLDOWN");
  chk("冷却拒绝里带剩余时间", cooling.remainingMs, 30 * 60000 - 10_000);
  chk("冷却刚好过 → 放行",
    planEventReward({ config, observed: { count: 1, lastAt: 990_000 }, requested: 20, now: 990_000 + 30 * 60000 }).ok, true);

  chk("今日发满 → 拒",
    planEventReward({ config, observed: { count: 3, lastAt: 0 }, requested: 20, now: 1_000_000 }).code, "DAILY_LIMIT");

  chk("事件不存在 → 拒",
    planEventReward({ config: null, observed: none, requested: 20, now: 1_000_000 }).code, "EVENT_NOT_FOUND");
  chk("事件停用 → 拒",
    planEventReward({ config: { ...config, enabled: false }, observed: none, requested: 20, now: 1_000_000 }).code, "EVENT_DISABLED");
  // fish-escape 是消耗端（把鱼带走），不发泡泡 —— 别让它变成刷泡泡的入口。
  chk("不发泡泡的 handler → 拒",
    planEventReward({ config: { ...config, handler: "fish-escape" }, observed: none, requested: 20, now: 1_000_000 }).code, "EVENT_NO_BUBBLES");
}

// ===== 4. 起服务：HTTP 层 =====
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDS = Buffer.from(JSON.stringify({
  private_key_id: "bubble-key-id-0001", private_key: privateKey, env_id: "bubble-env-0001"
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
const push = (token, bubbles) => call("PUT", "/api/game/save", { token, body: SAVE(bubbles) });

try {
  console.log("\n--- 4. HTTP：反复 push 刷不出泡泡 ---");
  {
    const acc = await newAccount();
    chk("首次 push 建立存档", (await push(acc.token, 100)).body.data?.save?.PlayerData?.bubbles, 100);

    // 攻击模拟：循环报「服务端现值 + 2000」，旧规则每次都会放行 → 10 次就是 +20000。
    let last = 100;
    for (let i = 0; i < 10; i++) {
      const r = await push(acc.token, last + 2000);
      last = r.body.data?.save?.PlayerData?.bubbles;
    }
    chk("🔴 连刷 10 次「现值 +2000」→ 泡泡纹丝不动", last, 100);

    // 换个姿势：直接报一个天文数字。
    chk("🔴 直接报 1e9 → 仍回落到服务端现值", (await push(acc.token, 1e9)).body.data?.save?.PlayerData?.bubbles, 100);

    // 正当消费：下调必须照常放行，否则玩家买不了东西。
    chk("下调到 30 放行", (await push(acc.token, 30)).body.data?.save?.PlayerData?.bubbles, 30);
  }

  console.log("\n--- 5. HTTP：服务端加的泡泡不会被客户端夹掉（grants 的核心不变量）---");
  {
    const acc = await newAccount();
    await push(acc.token, 100);

    // 后台发 50 泡泡。玩家本地还不知道这件事，下一次 push 报的是旧的 100。
    const granted = await call("POST", "/api/admin/grants", {
      adminKey: ADMIN_KEY,
      body: { userIds: [acc.uid], bubbles: 50, reason: "测试补偿", mode: "apply" }
    });
    chk("后台发放成功", granted.status, 200);

    const after = await push(acc.token, 100);
    chk("🔴 客户端推旧值 100 → 服务端存档是 100 + 50", after.body.data?.save?.PlayerData?.bubbles, 150);
    chk("push 响应带上了本次结算的小票", after.body.data?.claimedGrants?.bubbles, 50);
    chk("小票里的余额是结算后的值", after.body.data?.claimedGrants?.balance, 150);

    // 玩家端拿到响应后会**采用**服务端存档（pushCloudSave 里 data.save 一律 adopt），
    // 所以第二次推的是对齐后的 150 —— 既不该被夹掉，也不该重复发。
    const again = await push(acc.token, 150);
    chk("对齐后再推 → 仍是 150", again.body.data?.save?.PlayerData?.bubbles, 150);
    chk("第二次没有小票（没有新的待领取）", again.body.data?.claimedGrants, null);

    // ⚠️ 已知取舍（**特征测试**，不是「期望的正确行为」）：
    //    客户端仍保留「下调」权 —— 离线消费要走这条路，而服务端分不清「玩家花了钱」
    //    和「客户端拿的是旧值」。所以如果 push 的响应在服务端写完之后丢了，
    //    客户端手上还是 100，下一次 push 就会把服务端泡泡压回 100，那 50 就没了。
    //    这是「客户端可下调」与「服务端权威」之间的固有张力。要彻底消除就得取消
    //    客户端的下调权 —— 代价是离线购买路径失效（那条路径现在也只保住泡泡、
    //    保不住物品，因为库存是服务端权威）。本轮**刻意不做**，留作独立改动。
    //    下面这条一旦失败，说明有人改了这个语义 —— 请连同上面那段注释一起更新。
    const stale = await push(acc.token, 100);
    chk("（已知取舍）响应丢失后推旧值 → 服务端泡泡被压回旧值", stale.body.data?.save?.PlayerData?.bubbles, 100);

    // 玩家本地对齐之后正常消费。
    chk("下调到 20 放行（消费路径没被误伤）", (await push(acc.token, 20)).body.data?.save?.PlayerData?.bubbles, 20);
  }

  console.log("\n--- 6. HTTP：专注奖励由服务端落账 ---");
  {
    const acc = await newAccount();
    await push(acc.token, 100);

    const started = await call("POST", "/api/game/focus/start", { token: acc.token, body: { plannedMinutes: 25 } });
    chk("开始专注 → 201", started.status, 201);
    const sessionId = started.body.data?.sessionId;

    // 立刻完成：服务端按实际耗时算，25 分钟没到 → countedMinutes 为 0 → 不发奖。
    const quick = await call("POST", "/api/game/focus/complete", { token: acc.token, body: { sessionId } });
    chk("完成 → 200", quick.status, 200);
    chk("没攒够时长 → 奖励 0", quick.body.data?.reward, 0);
    chk("没攒够时长 → 不落账（不写空 grant）", quick.body.data?.granted, false);
    chk("泡泡没变", (await call("GET", "/api/game/save", { token: acc.token })).body.data?.save?.PlayerData?.bubbles, 100);

    // 反向：同一条会话不能再结算一次（防重放）。
    chk("重复结算同一条会话 → 404",
      (await call("POST", "/api/game/focus/complete", { token: acc.token, body: { sessionId } })).status, 404);
  }

  console.log("\n--- 7. HTTP：事件奖励接口 ---");
  {
    const acc = await newAccount();
    await push(acc.token, 100);

    // 事件配置来自 seed（已发布）。先确认至少有一个 give-bubbles 事件。
    // ⚠️ 公开接口的字段形状：配置本体在 `data` 里（`{ ...record, data: publishedData }`），
    //    不是平铺在顶层 —— 直接读 e.handler 会永远找不到。
    const events = await call("GET", "/api/game/events");
    const list = (Array.isArray(events.body.data) ? events.body.data : [])
      .map(record => ({ id: record.id, ...(record.data || {}) }));
    const bubbleEvent = list.find(e => e && e.handler === "give-bubbles" && e.enabled !== false);
    chkTrue("已发布配置里有启用的 give-bubbles 事件（否则这条链路测不到）",
      Boolean(bubbleEvent), `拿到 ${list.length} 个事件：${list.map(e => e.handler).join(",")}`);

    chk("缺 eventId → 400", (await call("POST", "/api/game/events/reward", { token: acc.token, body: {} })).status, 400);
    chk("不存在的事件 → 404",
      (await call("POST", "/api/game/events/reward", { token: acc.token, body: { eventId: "no-such-event" } })).status, 404);
    chk("没有令牌 → 401", (await call("POST", "/api/game/events/reward", { body: { eventId: "x" } })).status, 401);

    if (bubbleEvent) {
      const first = await call("POST", "/api/game/events/reward", {
        token: acc.token, body: { eventId: bubbleEvent.id, bubbles: bubbleEvent.params?.max }
      });
      chk("首次触发 → 200", first.status, 200);
      const grantedBubbles = first.body.data?.bubbles;
      chkTrue("发的数量在配置区间内",
        grantedBubbles >= bubbleEvent.params.min && grantedBubbles <= bubbleEvent.params.max,
        `拿到 ${grantedBubbles}，区间 ${bubbleEvent.params.min}-${bubbleEvent.params.max}`);
      chk("服务端当场结算，返回了新存档", first.body.data?.save?.PlayerData?.bubbles, 100 + grantedBubbles);

      // 🔴 冷却/上限：立刻再来一次必须被拒，且**不能**本地补发。
      const second = await call("POST", "/api/game/events/reward", {
        token: acc.token, body: { eventId: bubbleEvent.id, bubbles: bubbleEvent.params?.max }
      });
      const expectedReject = bubbleEvent.cooldownMinutes > 0 || bubbleEvent.maxPerDay <= 1;
      if (expectedReject) {
        chk("立刻再触发 → 被冷却/上限拒掉", second.status, 409);
        chkTrue("拒绝码是冷却或上限",
          ["COOLDOWN", "DAILY_LIMIT"].includes(second.body.code), String(second.body.code));
        chk("被拒之后泡泡没有变化（没有绕过闸门）",
          (await call("GET", "/api/game/save", { token: acc.token })).body.data?.save?.PlayerData?.bubbles,
          100 + grantedBubbles);
      } else {
        chk("这个事件没有冷却也没有每日上限 —— 配置本身值得复核", false, true);
      }
    }
  }
} catch (error) {
  console.log(`\n测试中途抛异常：${error.stack || error.message}`);
  fail++;
} finally {
  server.kill();
}

console.log(`\n===== bubble-authority: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
