// 随机事件系统回归测试（F6 / F8 / F10 / F12 + S2 / S6 / S8）
//
// 覆盖四层：
//   A. 服务端配置校验（api/event-config.js）
//   B. 种子事件数据（走内存仓库拿真实 seed，不手抄）
//   C. 前后端 handler 名单一致（不一致就是「后台能配出玩家端不认识的事件」）
//   D. 玩家端纯函数：检测节奏 / 冷却 / 每日上限 / 条件 / 概率 / 三个内置 handler
//
// 沿用项目约定：玩家端逻辑从 index.html 抽取**真实源码**到沙箱里跑，不手抄实现。
// 运行：node test/events.test.js
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_HANDLERS as SERVER_HANDLERS, validateEventConfig } from "../event-config.js";
import { createMemoryRepository } from "../repository.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");
const adminSource = fs.readFileSync(path.join(here, "..", "..", "admin.html"), "utf8");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS | ${name}`); }
  catch (e) { failed++; console.log(`FAIL | ${name} -> ${e.message}`); }
}

// ===== 从 index.html 抽取真实实现 =====
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}
// 抽 `const X = { ... }` 这种块（EVENT_HANDLERS 是对象字面量，不是 function）。
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`index.html 里找不到 ${marker}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${marker} 花括号不配对`);
}

// 抽 `const X = ...;` 这种标量常量（离线阈值是 const，不是 function）。
function extractConst(src, name) {
  const match = src.match(new RegExp(`const ${name} = [^;]+;`));
  if (!match) throw new Error(`index.html 里找不到常量 ${name}`);
  return match[0];
}
const SANDBOX_CONSTS = ["EVENT_OFFLINE_MIN_MS", "EVENT_OFFLINE_DEFAULT_CAP_HOURS"]
  .map(name => extractConst(source, name))
  .join("\n");

const PURE_FUNCTIONS = [
  "normalizeTags",
  "eventDayKey",
  "eventSlot",
  "eventDailyUsed",
  "eventCooldownRemaining",
  "eventCheckRemaining",
  "eventConditionsMet",
  "formatEventMessage",
  "randomInt",
  "escapableFish",
  "pickEventResults",
  "offlineElapsedMs",
  "offlineProbability",
  "pickOfflineEventResults"
];

const deps = {
  SHOP_ITEMS: [],
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  FISH_ASSEMBLY: [],
  getFishAssembly: fishId => deps.FISH_ASSEMBLY.find(fish => fish.fishid === fishId),
  getItem: id => deps.SHOP_ITEMS.find(item => item && item.id === id),
  aquariumValue: (data, item) => item.category === "decorations" ? data.decoration
    : item.category === "backgrounds" ? data.background
    : item.category === "sands" ? data.sand
    : item.category === "sounds" ? data.ambientSound : null
};

const sandbox = new Function("deps", `
const { SHOP_ITEMS, AquariumData, FISH_ASSEMBLY, getFishAssembly, getItem, aquariumValue } = deps;
${SANDBOX_CONSTS}
${PURE_FUNCTIONS.map(name => extractFunction(source, name)).join("\n")}
${extractBlock(source, "const EVENT_HANDLERS")}
return { ${PURE_FUNCTIONS.join(", ")}, EVENT_HANDLERS };
`)(deps);

const { EVENT_HANDLERS: PLAYER_HANDLERS } = sandbox;

// 每个用例前把假数据恢复干净（沙箱里的 const 绑的是同一批对象，改内容即可）。
function resetWorld() {
  deps.SHOP_ITEMS.length = 0;
  deps.AquariumData.fish.length = 0;
  deps.FISH_ASSEMBLY.length = 0;
  deps.AquariumData.decoration = "";
  deps.AquariumData.background = "";
  deps.AquariumData.sand = "";
  deps.AquariumData.ambientSound = "";
}
const NOW = new Date("2026-09-23T12:00:00").getTime(); // 本地时间正午，避开跨天边界

function baseConfig(overrides = {}) {
  return {
    id: "give-bubbles",
    name: "意外的礼物",
    enabled: true,
    eventType: "online",
    handler: "give-bubbles",
    params: { min: 5, max: 15 },
    relatedTag: "",
    probability: 1,
    checkIntervalSeconds: 60,
    cooldownMinutes: 30,
    maxPerDay: 3,
    message: "小鱼翻出了 {count} 颗泡泡。",
    conditions: { minFish: 0, minBubbles: 0, hasTag: "" },
    ...overrides
  };
}
const ctx = (overrides = {}) => ({ fishCount: 3, bubbles: 100, tags: [], ...overrides });

console.log("--- A. 服务端配置校验 ---");
test("合法事件配置通过", () => {
  assert.strictEqual(validateEventConfig(baseConfig()), null);
});
test("缺 id / id 非法字符被拦", () => {
  assert.match(validateEventConfig(baseConfig({ id: "" })), /id/);
  assert.match(validateEventConfig(baseConfig({ id: "有中文" })), /id/);
});
test("handler 不在白名单被拦（防后台配出玩家端不认识的事件）", () => {
  assert.match(validateEventConfig(baseConfig({ handler: "do-something-crazy" })), /handler/);
});
test("probability 必须落在 (0,1]", () => {
  assert.match(validateEventConfig(baseConfig({ probability: 0 })), /probability/);
  assert.match(validateEventConfig(baseConfig({ probability: 1.5 })), /probability/);
  assert.strictEqual(validateEventConfig(baseConfig({ probability: 0.5 })), null);
});
test("检测间隔 / 冷却 / 每日上限的范围", () => {
  assert.match(validateEventConfig(baseConfig({ checkIntervalSeconds: 1 })), /checkIntervalSeconds/);
  assert.match(validateEventConfig(baseConfig({ cooldownMinutes: -1 })), /cooldownMinutes/);
  assert.match(validateEventConfig(baseConfig({ maxPerDay: 0 })), /maxPerDay/);
});
test("检测间隔只对在线事件强制（离线事件是按「再次进入」结算的）", () => {
  const offline = baseConfig({ eventType: "offline" });
  delete offline.checkIntervalSeconds;
  assert.strictEqual(validateEventConfig(offline), null, "离线事件不该被要求填检测间隔");
  // 在线事件仍然必须填
  const online = baseConfig();
  delete online.checkIntervalSeconds;
  assert.match(validateEventConfig(online), /checkIntervalSeconds/);
});
test("message 不能为空（事件一定要有话说）", () => {
  assert.match(validateEventConfig(baseConfig({ message: "   " })), /message/);
});
test("treasure 必须填 relatedTag（否则永远匹配不到资源）", () => {
  assert.match(validateEventConfig(baseConfig({ handler: "treasure", relatedTag: "" })), /relatedTag/);
  assert.strictEqual(validateEventConfig(baseConfig({ handler: "treasure", relatedTag: "undersea-treasure" })), null);
});
test("params / conditions 必须是对象", () => {
  assert.match(validateEventConfig(baseConfig({ params: [] })), /params/);
  assert.match(validateEventConfig(baseConfig({ conditions: [] })), /conditions/);
});

console.log("\n--- B. 种子事件数据 ---");
const seedEvents = await (async () => {
  const repo = createMemoryRepository();
  const records = await repo.list("events", true);
  return records.map(record => record.data);
})();
test("种子里有 4 个事件（3 个在线 + 1 个离线）", () => {
  assert.strictEqual(seedEvents.length, 4);
  const online = seedEvents.filter(e => (e.eventType || "online") === "online");
  const offline = seedEvents.filter(e => e.eventType === "offline");
  assert.strictEqual(online.length, 3, "F12 的三个第一阶段事件应该都是在线事件");
  assert.strictEqual(offline.length, 1, "F11 需要一个离线事件，否则这条链路没人用");
});
test("F11: 离线事件配了单次时长上限（防挂机刷）", () => {
  const offline = seedEvents.find(e => e.eventType === "offline");
  assert.ok(Number(offline.params.maxOfflineHours) >= 1, "必须配 maxOfflineHours");
});
test("种子事件 id 唯一", () => {
  assert.strictEqual(new Set(seedEvents.map(e => e.id)).size, seedEvents.length);
});
test("每个种子事件都能通过服务端校验", () => {
  seedEvents.forEach(event => {
    const error = validateEventConfig(event);
    assert.strictEqual(error, null, `${event.id}: ${error}`);
  });
});
test("F12 三个内置 handler 都被种子覆盖", () => {
  const used = new Set(seedEvents.map(e => e.handler));
  SERVER_HANDLERS.forEach(handler => assert.ok(used.has(handler), `种子缺少 handler: ${handler}`));
});

// 事件与资源唯一的关联方式就是 tag（S2 / F15）。这一步断掉的话事件不会报错、
// 也不会给泡泡 —— 它只是**永远不触发**，从日志和界面上都看不出来。
const seedResources = await (async () => {
  const repo = createMemoryRepository();
  const [decorations, fish] = await Promise.all([repo.list("decorations", true), repo.list("fish", true)]);
  return [...decorations, ...fish].map(record => record.data);
})();
const tagsOf = item => {
  const raw = Array.isArray(item.tags) ? item.tags : (typeof item.tags === "string" ? [item.tags] : []);
  return raw.map(tag => String(tag).trim().toLowerCase()).filter(Boolean);
};
test("S2: relatedTag 引用的 tag 必须有种子资源挂着（否则事件永远不触发）", () => {
  const allTags = new Set(seedResources.flatMap(tagsOf));
  const referenced = seedEvents.filter(event => event.relatedTag);
  assert.ok(referenced.length > 0, "种子里应该有事件用到 relatedTag，否则这条链路没有真实用例");
  referenced.forEach(event => {
    const tag = String(event.relatedTag).trim().toLowerCase();
    assert.ok(allTags.has(tag), `事件「${event.id}」引用 tag「${event.relatedTag}」，但没有任何种子资源带它 —— 这个事件永远不会触发`);
  });
});
test("S2: conditions.hasTag 同上，也要有资源挂得上", () => {
  const allTags = new Set(seedResources.flatMap(tagsOf));
  seedEvents
    .filter(event => event.conditions && event.conditions.hasTag)
    .forEach(event => {
      const tag = String(event.conditions.hasTag).trim().toLowerCase();
      assert.ok(allTags.has(tag), `事件「${event.id}」的条件要求 tag「${event.conditions.hasTag}」，但没有种子资源带它 —— 条件永远不成立`);
    });
});
test("S6: fish-escape 配了最短存活时间（刚买不久的鱼不参与逃逸）", () => {
  const escape = seedEvents.find(e => e.handler === "fish-escape");
  assert.ok(Number(escape.params.minSurvivalMinutes) >= 60, "minSurvivalMinutes 太小");
  assert.ok(Number(escape.conditions.minFish) >= 2, "不能让最后一条鱼也走掉");
});

console.log("\n--- C. 前后端 handler 名单一致 ---");
test("index.html 的 EVENT_HANDLERS 与 api/event-config.js 一致", () => {
  assert.deepStrictEqual(Object.keys(PLAYER_HANDLERS).sort(), [...SERVER_HANDLERS].sort());
});
test("admin.html 的下拉选项与白名单一致", () => {
  // 只在 EVENT_HANDLER_OPTIONS 这一块里找，别把 EVENT_TYPE_OPTIONS 的 online/offline 也算进来。
  const block = adminSource.match(/const EVENT_HANDLER_OPTIONS = \[([\s\S]*?)\];/);
  assert.ok(block, "admin.html 里找不到 EVENT_HANDLER_OPTIONS");
  const options = [...block[1].matchAll(/value: "([a-z-]+)"/g)].map(match => match[1]);
  assert.deepStrictEqual(options.sort(), [...SERVER_HANDLERS].sort());
});

console.log("\n--- D. 玩家端纯函数 ---");
test("eventDayKey 用本地日期分桶", () => {
  assert.strictEqual(sandbox.eventDayKey(NOW), "2026-09-23");
});
test("跨天后每日计数归零", () => {
  const runtime = { e1: { dayKey: "2026-09-22", dayCount: 3 } };
  assert.strictEqual(sandbox.eventDailyUsed(runtime, "e1", NOW), 0);
  assert.strictEqual(sandbox.eventDailyUsed({ e1: { dayKey: "2026-09-23", dayCount: 2 } }, "e1", NOW), 2);
});
test("冷却剩余时间算得对", () => {
  const config = baseConfig({ cooldownMinutes: 30 });
  const runtime = { "give-bubbles": { lastTriggeredAt: NOW - 10 * 60000 } };
  assert.strictEqual(sandbox.eventCooldownRemaining(runtime, config, NOW), 20 * 60000);
  assert.strictEqual(sandbox.eventCooldownRemaining({ "give-bubbles": { lastTriggeredAt: NOW - 40 * 60000 } }, config, NOW), 0);
  assert.strictEqual(sandbox.eventCooldownRemaining({}, config, NOW), 0, "从没触发过就是可用");
});
test("检测节奏：没到间隔不算该检测", () => {
  const config = baseConfig({ checkIntervalSeconds: 60 });
  assert.strictEqual(sandbox.eventCheckRemaining({ "give-bubbles": { lastCheckedAt: NOW - 10000 } }, config, NOW), 50000);
  assert.strictEqual(sandbox.eventCheckRemaining({ "give-bubbles": { lastCheckedAt: NOW - 90000 } }, config, NOW), 0);
  assert.strictEqual(sandbox.eventCheckRemaining({}, config, NOW), 0, "从没检测过就该检测");
});
test("条件：minFish / minBubbles / hasTag", () => {
  assert.strictEqual(sandbox.eventConditionsMet({ minFish: 3 }, ctx({ fishCount: 2 })), false);
  assert.strictEqual(sandbox.eventConditionsMet({ minFish: 3 }, ctx({ fishCount: 3 })), true);
  assert.strictEqual(sandbox.eventConditionsMet({ minBubbles: 200 }, ctx({ bubbles: 100 })), false);
  assert.strictEqual(sandbox.eventConditionsMet({ minBubbles: 100 }, ctx({ bubbles: 100 })), true);
  assert.strictEqual(sandbox.eventConditionsMet({ hasTag: "undersea-treasure" }, ctx({ tags: [] })), false);
  assert.strictEqual(sandbox.eventConditionsMet({ hasTag: "undersea-treasure" }, ctx({ tags: ["Undersea-Treasure"] })), true, "tag 大小写不敏感");
  assert.strictEqual(sandbox.eventConditionsMet({}, ctx()), true, "空条件 = 不限");
});
test("文案占位符替换；取不到值不留裸露的 {xxx}", () => {
  assert.strictEqual(sandbox.formatEventMessage("拿到 {count} 颗", { count: 7 }), "拿到 7 颗");
  assert.strictEqual(sandbox.formatEventMessage("{name} 跳走了", {}), " 跳走了");
  assert.strictEqual(sandbox.formatEventMessage("{a}{b}", { a: 1 }), "1");
  assert.strictEqual(sandbox.formatEventMessage("没有占位符", { a: 1 }), "没有占位符");
});
test("randomInt 落在闭区间内", () => {
  assert.strictEqual(sandbox.randomInt(() => 0, 5, 15), 5);
  assert.strictEqual(sandbox.randomInt(() => 0.999999, 5, 15), 15);
  assert.strictEqual(sandbox.randomInt(() => 0.5, 0, 0), 0);
});

console.log("\n--- E. 检测流水线 pickEventResults ---");
function pick(configs, runtime, context, rand, now = NOW) {
  return sandbox.pickEventResults(configs, runtime, context, now, rand);
}
test("概率命中 → 产出结果，并把该事件记为已检测", () => {
  const out = pick([baseConfig()], {}, ctx(), () => 0);
  assert.strictEqual(out.results.length, 1);
  assert.deepStrictEqual(out.checked, ["give-bubbles"]);
});
test("没到检测间隔 → 这次不检测（checked 为空）", () => {
  const out = pick([baseConfig()], { "give-bubbles": { lastCheckedAt: NOW - 1000 } }, ctx(), () => 0);
  assert.strictEqual(out.results.length, 0);
  assert.deepStrictEqual(out.checked, []);
});
test("没命中也要记已检测，否则节奏永远不推进", () => {
  const out = pick([baseConfig({ probability: 0.5 })], {}, ctx(), () => 0.9);
  assert.strictEqual(out.results.length, 0);
  assert.deepStrictEqual(out.checked, ["give-bubbles"], "未触发的事件也必须推进检测节奏");
});
test("enabled=false / offline 事件不参与在线检测", () => {
  assert.strictEqual(pick([baseConfig({ enabled: false })], {}, ctx(), () => 0).results.length, 0);
  assert.strictEqual(pick([baseConfig({ eventType: "offline" })], {}, ctx(), () => 0).results.length, 0);
});
test("条件不满足 → 不触发", () => {
  const config = baseConfig({ conditions: { minFish: 5 } });
  assert.strictEqual(pick([config], {}, ctx({ fishCount: 1 }), () => 0).results.length, 0);
});
test("每日上限到了 → 不触发", () => {
  const runtime = { "give-bubbles": { dayKey: sandbox.eventDayKey(NOW), dayCount: 3 } };
  assert.strictEqual(pick([baseConfig({ maxPerDay: 3 })], runtime, ctx(), () => 0).results.length, 0);
});
test("冷却中 → 不触发", () => {
  const runtime = { "give-bubbles": { lastTriggeredAt: NOW - 60000 } };
  assert.strictEqual(pick([baseConfig({ cooldownMinutes: 30 })], runtime, ctx(), () => 0).results.length, 0);
});
test("handler 不存在 → 静默跳过，不抛错", () => {
  const out = pick([baseConfig({ handler: "not-a-handler" })], {}, ctx(), () => 0);
  assert.strictEqual(out.results.length, 0);
});
test("handler 返回 null（这次不成立）→ 不计入结果", () => {
  // give-bubbles 的区间是 0~0，永远拿不到泡泡
  const out = pick([baseConfig({ params: { min: 0, max: 0 } })], {}, ctx(), () => 0);
  assert.strictEqual(out.results.length, 0);
  assert.deepStrictEqual(out.checked, ["give-bubbles"], "仍然要推进检测节奏");
});
test("多个事件各自独立判定", () => {
  const configs = [
    baseConfig({ id: "a", handler: "give-bubbles" }),
    baseConfig({ id: "b", handler: "give-bubbles", conditions: { minFish: 99 } }),
    baseConfig({ id: "c", handler: "give-bubbles", enabled: false })
  ];
  const out = pick(configs, {}, ctx(), () => 0);
  assert.deepStrictEqual(out.results.map(r => r.config.id), ["a"]);
  assert.deepStrictEqual(out.checked.sort(), ["a", "b"]);
});

console.log("\n--- E2. 离线结算 pickOfflineEventResults（F11 / S7）---");
function offlineConfig(overrides = {}) {
  return baseConfig({
    id: "welcome-back",
    name: "久别重逢",
    eventType: "offline",
    params: { min: 8, max: 24, maxOfflineHours: 24 },
    probability: 0.3,
    cooldownMinutes: 480,
    maxPerDay: 1,
    ...overrides
  });
}
test("offlineElapsedMs：首次进入不判定", () => {
  assert.strictEqual(sandbox.offlineElapsedMs(0, NOW, 24), 0);
  assert.strictEqual(sandbox.offlineElapsedMs(undefined, NOW, 24), 0);
  assert.strictEqual(sandbox.offlineElapsedMs(null, NOW, 24), 0);
});
test("offlineElapsedMs：时钟回拨（lastSeenAt 在未来）整段作废", () => {
  assert.strictEqual(sandbox.offlineElapsedMs(NOW + 60000, NOW, 24), 0);
});
test("offlineElapsedMs：离开不足 5 分钟不算「离开过」（刷新页面不该被判成离线回来）", () => {
  assert.strictEqual(sandbox.offlineElapsedMs(NOW - 60 * 1000, NOW, 24), 0);
  assert.strictEqual(sandbox.offlineElapsedMs(NOW - 5 * 60 * 1000, NOW, 24), 5 * 60 * 1000);
});
test("offlineElapsedMs：单次离线时长封顶（挂一天和挂一周一样）", () => {
  assert.strictEqual(sandbox.offlineElapsedMs(NOW - 2 * 3600000, NOW, 24), 2 * 3600000);
  assert.strictEqual(sandbox.offlineElapsedMs(NOW - 100 * 3600000, NOW, 24), 24 * 3600000);
  assert.strictEqual(sandbox.offlineElapsedMs(NOW - 100 * 3600000, NOW, undefined), 24 * 3600000, "默认上限 24h");
});
test("offlineProbability：probability 是每小时命中率，离线越久越高，封顶 1", () => {
  assert.strictEqual(sandbox.offlineProbability(0.3, 0), 0);
  assert.strictEqual(sandbox.offlineProbability(0.3, 2 * 3600000), 0.6);
  assert.strictEqual(sandbox.offlineProbability(0.3, 10 * 3600000), 1);
});
test("离线结算：在线事件不参与", () => {
  const out = sandbox.pickOfflineEventResults([baseConfig({ eventType: "online" })], {}, ctx(), NOW - 3600000, NOW, () => 0);
  assert.strictEqual(out.length, 0);
});
test("离线结算：enabled=false 不参与", () => {
  const out = sandbox.pickOfflineEventResults([offlineConfig({ enabled: false })], {}, ctx(), NOW - 3600000, NOW, () => 0);
  assert.strictEqual(out.length, 0);
});
test("离线结算：首次进入（没有 lastSeenAt）不触发", () => {
  const out = sandbox.pickOfflineEventResults([offlineConfig()], {}, ctx(), 0, NOW, () => 0);
  assert.strictEqual(out.length, 0);
});
test("离线结算：离线 2 小时 + 每小时 0.3 → 命中并带上离线时长", () => {
  const out = sandbox.pickOfflineEventResults([offlineConfig()], {}, ctx(), NOW - 2 * 3600000, NOW, () => 0);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].config.id, "welcome-back");
  assert.strictEqual(out[0].offlineMs, 2 * 3600000);
  assert.strictEqual(out[0].effect.bubbles, 8);
  assert.strictEqual(out[0].effect.message, "小鱼翻出了 8 颗泡泡。");
});
test("离线结算：概率随离线时长放大（离线越久越可能）", () => {
  const config = offlineConfig({ probability: 0.1 }); // 离线 1h → 0.1；离线 8h → 0.8
  const shortAway = sandbox.pickOfflineEventResults([config], {}, ctx(), NOW - 3600000, NOW, () => 0.5);
  const longAway = sandbox.pickOfflineEventResults([config], {}, ctx(), NOW - 8 * 3600000, NOW, () => 0.5);
  assert.strictEqual(shortAway.length, 0, "离线 1 小时不该被 0.5 命中");
  assert.strictEqual(longAway.length, 1, "离线 8 小时应该被 0.5 命中");
});
test("离线结算：单次时长上限真的生效（挂 100 小时按 24 小时算）", () => {
  const config = offlineConfig({ probability: 0.03, params: { min: 8, max: 24, maxOfflineHours: 24 } });
  // 按 24h 算 → 0.72；不封顶按 100h 算 → 1。用 0.8 区分。
  const out = sandbox.pickOfflineEventResults([config], {}, ctx(), NOW - 100 * 3600000, NOW, () => 0.8);
  assert.strictEqual(out.length, 0, "封顶没生效：0.8 不该命中（0.72）");
});
test("离线结算：每日上限 / 冷却 / 条件都生效", () => {
  const runtime = { "welcome-back": { dayKey: sandbox.eventDayKey(NOW), dayCount: 1 } };
  assert.strictEqual(sandbox.pickOfflineEventResults([offlineConfig()], runtime, ctx(), NOW - 2 * 3600000, NOW, () => 0).length, 0, "每日上限");
  const cooldown = { "welcome-back": { lastTriggeredAt: NOW - 60000 } };
  assert.strictEqual(sandbox.pickOfflineEventResults([offlineConfig()], cooldown, ctx(), NOW - 2 * 3600000, NOW, () => 0).length, 0, "冷却");
  const conditions = offlineConfig({ conditions: { minFish: 99 } });
  assert.strictEqual(sandbox.pickOfflineEventResults([conditions], {}, ctx({ fishCount: 1 }), NOW - 2 * 3600000, NOW, () => 0).length, 0, "条件");
});

console.log("\n--- F. 内置 handler ---");
test("give-bubbles：区间内给泡泡并填好文案", () => {
  resetWorld();
  const effect = PLAYER_HANDLERS["give-bubbles"](baseConfig({ params: { min: 5, max: 5 } }), ctx(), () => 0);
  assert.strictEqual(effect.bubbles, 5);
  assert.strictEqual(effect.message, "小鱼翻出了 5 颗泡泡。");
});
test("treasure：缸里没摆带该 tag 的资源 → 这次不成立", () => {
  resetWorld();
  deps.SHOP_ITEMS.push({ id: "d1", category: "decorations", name: "沉船", tags: ["undersea-treasure"] });
  deps.AquariumData.decoration = "other";
  const config = baseConfig({ handler: "treasure", relatedTag: "undersea-treasure", params: { min: 10, max: 10 }, message: "从{source}里叼出 {count} 颗" });
  assert.strictEqual(PLAYER_HANDLERS.treasure(config, ctx(), () => 0), null);
});
test("treasure：摆出来了就能叼出泡泡，{source} 用商品名", () => {
  resetWorld();
  deps.SHOP_ITEMS.push({ id: "d1", category: "decorations", name: "沉船", tags: ["Undersea-Treasure"] });
  deps.AquariumData.decoration = "d1";
  const config = baseConfig({ handler: "treasure", relatedTag: "undersea-treasure", params: { min: 10, max: 10 }, message: "从{source}里叼出 {count} 颗" });
  const effect = PLAYER_HANDLERS.treasure(config, ctx(), () => 0);
  assert.strictEqual(effect.bubbles, 10);
  assert.strictEqual(effect.source, "沉船");
  assert.strictEqual(effect.message, "从沉船里叼出 10 颗");
});
test("fish-escape：刚买不久的鱼不参与（S6）", () => {
  resetWorld();
  deps.AquariumData.fish.push({ instanceId: "f1", itemId: "fish001", acquiredAt: NOW - 60 * 1000 });
  const config = baseConfig({ handler: "fish-escape", params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 } });
  assert.strictEqual(PLAYER_HANDLERS["fish-escape"](config, ctx(), () => 0, NOW), null);
});
test("fish-escape：老存档的鱼（没有 acquiredAt）视为早就养着了，可以走", () => {
  resetWorld();
  deps.AquariumData.fish.push({ instanceId: "f1", itemId: "fish001" });
  deps.FISH_ASSEMBLY.push({ fishid: "fish001", name: "小丑鱼" });
  const config = baseConfig({ handler: "fish-escape", params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 }, message: "{name} 跳出了鱼缸" });
  const effect = PLAYER_HANDLERS["fish-escape"](config, ctx(), () => 0, NOW);
  assert.deepStrictEqual(effect.lost, [{ instanceId: "f1", name: "小丑鱼" }]);
  assert.strictEqual(effect.message, "小丑鱼 跳出了鱼缸");
});
test("fish-escape：系统时钟被回拨时也不放鱼走", () => {
  resetWorld();
  deps.AquariumData.fish.push({ instanceId: "f1", itemId: "fish001", acquiredAt: NOW + 3600 * 1000 });
  const config = baseConfig({ handler: "fish-escape", params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 } });
  assert.strictEqual(PLAYER_HANDLERS["fish-escape"](config, ctx(), () => 0, NOW), null);
});
test("fish-escape：单次最多失去的条数受 maxLostPerEvent 限制", () => {
  resetWorld();
  for (let i = 0; i < 5; i += 1) deps.AquariumData.fish.push({ instanceId: `f${i}`, itemId: "fish001" });
  deps.FISH_ASSEMBLY.push({ fishid: "fish001", name: "小丑鱼" });
  const config = baseConfig({ handler: "fish-escape", params: { minSurvivalMinutes: 0, maxLostPerEvent: 2 } });
  const effect = PLAYER_HANDLERS["fish-escape"](config, ctx(), () => 0, NOW);
  assert.strictEqual(effect.lost.length, 2);
});
test("fish-escape：没有可走的鱼 → 这次不成立（空缸不会更空）", () => {
  resetWorld();
  const config = baseConfig({ handler: "fish-escape", params: { minSurvivalMinutes: 0, maxLostPerEvent: 1 } });
  assert.strictEqual(PLAYER_HANDLERS["fish-escape"](config, ctx(), () => 0, NOW), null);
});
test("每个 handler 都接受 (config, ctx, rand, now) 四个参数且不碰全局", () => {
  resetWorld();
  Object.entries(PLAYER_HANDLERS).forEach(([name, handler]) => {
    assert.strictEqual(typeof handler, "function", `${name} 不是函数`);
    assert.ok(handler.length <= 4, `${name} 参数过多`);
  });
});

console.log(`\n----\nevents.test: PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
