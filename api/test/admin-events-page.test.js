// 后台「事件设置」页面的渲染冒烟测试（F7）。
//
// 为什么要有它：事件页是纯字符串模板拼出来的，拼错了（变量名打错 → 页面出现 undefined、
// 少一个 </div> → 布局崩掉）在 Node 侧完全看不出来，只能等人工打开后台才发现。
// 这里用**极简假 DOM** 把 admin.html 的真实脚本跑起来，直接调用 renderEventList / renderEventForm，
// 检查产出的 HTML。不引入 jsdom，保持零依赖。
//
// 跑法：node test/admin-events-page.test.js
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..", "..");
const adminHtml = fs.readFileSync(path.join(projectRoot, "admin.html"), "utf8");
const gameDataSource = fs.readFileSync(path.join(projectRoot, "game-data.js"), "utf8");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS | ${name}`); }
  catch (e) { failed++; console.log(`FAIL | ${name} -> ${e.message}`); }
}

// ===== 极简假 DOM =====
function makeElement(id = "") {
  return {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    dataset: {},
    style: {},
    elements: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
const elements = new Map();
const fakeDocument = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
  querySelectorAll() { return []; },
  // 页面刚写进 innerHTML 的元素，真实浏览器里一定查得到（renderEventForm 就是自己拼出来的），
  // 所以这里返回一个桩元素而不是 null —— 否则测的是「假 DOM 缺元素」而不是模板本身。
  querySelector() { return makeElement(); },
  createElement() { return makeElement(); },
  addEventListener() {}
};
const fakeWindow = {};
new Function("window", gameDataSource)(fakeWindow);

// 抽出 admin.html 里唯一的 <script> 内容并求值，返回内部函数给测试用。
const scriptSource = adminHtml.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const adminApi = new Function("document", "window", "sessionStorage", "localStorage", "fetch", `
${scriptSource}
return { state, renderEventList, renderEventForm, renderDecorationForm, renderFishForm, defaultEventItem, EVENT_HANDLER_OPTIONS, validateEventDraft, readEventParams };
`)(fakeDocument, fakeWindow, { getItem: () => null, setItem() {}, removeItem() {} }, { getItem: () => null, setItem() {}, removeItem() {} }, () => Promise.reject(new Error("测试里不该发请求")));

const main = fakeDocument.getElementById("main");

// ===== HTML 健全性检查 =====
function countTag(html, tag) {
  const open = (html.match(new RegExp(`<${tag}(?=[\\s>])`, "gi")) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, "gi")) || []).length;
  return { open, close };
}
function assertNoLeak(html, label) {
  assert.ok(!/undefined/.test(html), `${label} 里出现了 undefined（模板变量打错？）`);
  assert.ok(!/\[object Object\]/.test(html), `${label} 里出现了 [object Object]（对象没序列化？）`);
  assert.ok(!/NaN/.test(html), `${label} 里出现了 NaN（数值字段没填？）`);
}
function assertBalanced(html, label) {
  ["div", "section", "form", "table", "select", "textarea"].forEach(tag => {
    const { open, close } = countTag(html, tag);
    assert.strictEqual(open, close, `${label} 的 <${tag}> 不配对：开 ${open} 闭 ${close}`);
  });
}

console.log("--- 事件列表页 ---");
adminApi.state.events = [
  { id: "give-bubbles", name: "意外的礼物", handler: "give-bubbles", eventType: "online", probability: 0.03, checkIntervalSeconds: 60, cooldownMinutes: 30, maxPerDay: 3, enabled: true, published: true, dirty: false },
  { id: "treasure", name: "海底的宝藏", handler: "treasure", relatedTag: "undersea-treasure", eventType: "online", probability: 0.02, checkIntervalSeconds: 120, cooldownMinutes: 120, maxPerDay: 2, enabled: false, published: false, dirty: true }
];
adminApi.renderEventList();
const listHtml = main.innerHTML;
test("列表页渲染成功且没有模板变量泄漏", () => assertNoLeak(listHtml, "事件列表"));
test("列表页标签配对", () => assertBalanced(listHtml, "事件列表"));
test("列表页列出了事件名与 id", () => {
  assert.ok(listHtml.includes("意外的礼物") && listHtml.includes("give-bubbles"));
  assert.ok(listHtml.includes("海底的宝藏") && listHtml.includes("treasure"));
});
test("列表页显示关联 tag", () => assert.ok(listHtml.includes("undersea-treasure")));
test("列表页区分启用 / 停用", () => {
  assert.ok(listHtml.includes("启用") && listHtml.includes("停用"));
});
test("列表页区分已发布 / 待发布", () => {
  assert.ok(listHtml.includes("已发布") && listHtml.includes("有修改，待发布"));
});
test("空列表也能渲染（不炸）", () => {
  adminApi.state.events = [];
  adminApi.renderEventList();
  assertNoLeak(main.innerHTML, "空事件列表");
  assert.ok(main.innerHTML.includes("还没有事件"));
  adminApi.state.events = [
    { id: "give-bubbles", name: "意外的礼物", handler: "give-bubbles", eventType: "online", probability: 0.03, checkIntervalSeconds: 60, cooldownMinutes: 30, maxPerDay: 3, enabled: true, published: true, dirty: false }
  ];
});
test("列表用一句人话描述触发时机（在线含秒数，离线不含）", () => {
  // 2026-09-25 可读化改造：原来的机器口径「0.03 / 60s」「每小时离线」
  // 换成 describeEventRule 生成的一句话，在线/离线的口径区分保留。
  adminApi.renderEventList(); // 先渲染一次在线事件，确认在线那行有秒数
  assert.ok(main.innerHTML.includes("每 60 秒检测一次"), "在线事件应显示检测间隔");
  assert.ok(!main.innerHTML.includes("每小时离线"), "旧的机器口径不该再出现");
  adminApi.state.events = [
    { id: "welcome-back", name: "久别重逢", handler: "give-bubbles", eventType: "offline", probability: 0.3, checkIntervalSeconds: 60, cooldownMinutes: 480, maxPerDay: 1, enabled: true, published: true, dirty: false }
  ];
  adminApi.renderEventList();
  assert.ok(main.innerHTML.includes("玩家下次打开鱼缸时"), "离线事件的口径没标出来");
  assert.ok(!main.innerHTML.includes("每 60 秒检测一次"), "离线事件不该显示检测间隔秒数");
  adminApi.state.events = [
    { id: "give-bubbles", name: "意外的礼物", handler: "give-bubbles", eventType: "online", probability: 0.03, checkIntervalSeconds: 60, cooldownMinutes: 30, maxPerDay: 3, enabled: true, published: true, dirty: false }
  ];
});

console.log("\n--- 新建事件表单 ---");
adminApi.renderEventForm();
const newFormHtml = main.innerHTML;
test("新建表单渲染成功且没有模板变量泄漏", () => assertNoLeak(newFormHtml, "新建事件表单"));
test("新建表单标签配对", () => assertBalanced(newFormHtml, "新建事件表单"));
test("表单有全部必填字段", () => {
  ["id", "name", "handler", "eventType", "description", "message", "probability", "checkIntervalSeconds", "cooldownMinutes", "maxPerDay", "relatedTag", "enabled"]
    .forEach(field => assert.ok(newFormHtml.includes(`name="${field}"`), `缺少字段 ${field}`));
});
test("默认 handler 是 give-bubbles，且参数项跟着它走", () => {
  assert.ok(newFormHtml.includes('value="give-bubbles" selected'));
  assert.ok(newFormHtml.includes('data-event-param="min"'));
  assert.ok(newFormHtml.includes('data-event-param="max"'));
  assert.ok(!newFormHtml.includes('data-event-param="minSurvivalMinutes"'), "give-bubbles 不该有 fish-escape 的参数");
});
test("handler 下拉包含全部内置处理器", () => {
  adminApi.EVENT_HANDLER_OPTIONS.forEach(option => {
    assert.ok(newFormHtml.includes(`value="${option.value}"`), `下拉缺少 ${option.value}`);
  });
});
test("条件字段齐全", () => {
  ["cond_minFish", "cond_minBubbles", "cond_hasTag"].forEach(field => assert.ok(newFormHtml.includes(`name="${field}"`), `缺少条件 ${field}`));
});
test("检测间隔标注了「仅在线事件使用」", () => {
  assert.ok(newFormHtml.includes("仅在线事件使用"), "缺少提示：离线事件用不到这一项");
});

console.log("\n--- 编辑已有事件表单 ---");
adminApi.renderEventForm(0);
const editHtml = main.innerHTML;
test("编辑表单渲染成功且没有模板变量泄漏", () => assertNoLeak(editHtml, "编辑事件表单"));
test("编辑表单回填了事件名", () => assert.ok(editHtml.includes('value="意外的礼物"')));
test("编辑表单标签配对", () => assertBalanced(editHtml, "编辑事件表单"));

// fish-escape 的参数项与 give-bubbles 不同 —— 这是「不让用户手写 JSON」的关键
adminApi.state.events = [
  { id: "fish-escape", name: "小鱼跳出了鱼缸", handler: "fish-escape", eventType: "online", params: { minSurvivalMinutes: 1440, maxLostPerEvent: 1 }, probability: 0.01, checkIntervalSeconds: 300, cooldownMinutes: 720, maxPerDay: 1, enabled: true, message: "{name} 跳走了", conditions: { minFish: 2, minBubbles: 0, hasTag: "" }, published: true, dirty: false }
];
adminApi.renderEventForm(0);
const escapeHtml = main.innerHTML;
test("fish-escape 表单换成它自己的参数项并回填", () => {
  assert.ok(escapeHtml.includes('data-event-param="minSurvivalMinutes"'), "缺少 minSurvivalMinutes");
  assert.ok(escapeHtml.includes('data-event-param="maxLostPerEvent"'), "缺少 maxLostPerEvent");
  assert.ok(escapeHtml.includes('value="1440"'), "minSurvivalMinutes 没回填");
  assert.ok(!escapeHtml.includes('data-event-param="min"'), "fish-escape 不该有 min 参数项");
});
test("fish-escape 表单标签配对且无泄漏", () => {
  assertNoLeak(escapeHtml, "fish-escape 表单");
  assertBalanced(escapeHtml, "fish-escape 表单");
});

// F11：离线事件 —— eventType 要正确回填，且检测间隔带「仅在线事件使用」的提示
adminApi.state.events = [
  { id: "welcome-back", name: "久别重逢", handler: "give-bubbles", eventType: "offline", params: { min: 8, max: 24, maxOfflineHours: 24 }, probability: 0.3, checkIntervalSeconds: 60, cooldownMinutes: 480, maxPerDay: 1, enabled: true, message: "好久没来了。小鱼攒了 {count} 颗泡泡，都给你。", conditions: { minFish: 1, minBubbles: 0, hasTag: "" }, published: true, dirty: false }
];
adminApi.renderEventForm(0);
const offlineFormHtml = main.innerHTML;
test("离线事件表单：eventType 回填成 offline", () => {
  assert.ok(offlineFormHtml.includes('value="offline" selected'), "eventType 没回填成 offline");
  assert.ok(!offlineFormHtml.includes('value="online" selected'), "不该同时选中 online");
});
test("离线事件表单：多出「单次离线时长上限」参数项并回填（S7 防挂机刷）", () => {
  assert.ok(offlineFormHtml.includes('data-event-param="maxOfflineHours"'), "离线事件缺少 maxOfflineHours 输入项（配了也会在保存时被丢掉）");
  assert.ok(offlineFormHtml.includes('data-event-param="min"') && offlineFormHtml.includes('data-event-param="max"'), "仍应有 give-bubbles 自己的泡泡区间");
  assert.ok(offlineFormHtml.includes('value="8"') && offlineFormHtml.includes('value="24"'), "泡泡区间没回填");
});
test("在线事件不出现离线专属参数项", () => {
  adminApi.renderEventForm();  // 新建表单默认 online
  assert.ok(!main.innerHTML.includes('data-event-param="maxOfflineHours"'), "在线事件不该出现离线专属参数");
});
test("离线事件没配 maxOfflineHours 时输入框给默认值 24", () => {
  adminApi.state.events = [
    { id: "welcome-back", name: "久别重逢", handler: "give-bubbles", eventType: "offline", params: { min: 8, max: 24 }, probability: 0.3, checkIntervalSeconds: 60, cooldownMinutes: 480, maxPerDay: 1, enabled: true, message: "文案", conditions: {}, published: true, dirty: false }
  ];
  adminApi.renderEventForm(0);
  assert.ok(/data-event-param="maxOfflineHours"[^>]*value="24"/.test(main.innerHTML), "maxOfflineHours 没有默认值，用户得自己猜该填多少");
});
test("离线事件表单标签配对且无泄漏", () => {
  assertNoLeak(offlineFormHtml, "离线事件表单");
  assertBalanced(offlineFormHtml, "离线事件表单");
});

console.log("\n--- F9 接线：tags 输入框 ---");
test("商品表单恰好一个 tags 输入框（不再重复）", () => {
  adminApi.renderDecorationForm();
  const html = main.innerHTML;
  assert.strictEqual((html.match(/name="tags"/g) || []).length, 1, "tags 输入框重复了");
  assert.ok(html.includes('name="tags"'), "缺少 tags 输入框");
  assertNoLeak(html, "商品表单");
});
test("鱼种表单恰好一个 tags 输入框", () => {
  adminApi.renderFishForm();
  const html = main.innerHTML;
  assert.strictEqual((html.match(/name="tags"/g) || []).length, 1, "tags 输入框重复了");
  assertNoLeak(html, "鱼种表单");
  assertBalanced(html, "鱼种表单");
});

console.log("\n--- 前端草稿校验（与 api/event-config.js 同规则）---");
test("合法草稿通过", () => {
  const good = { ...adminApi.defaultEventItem(), id: "ok-id", name: "名字", message: "文案" };
  assert.strictEqual(adminApi.validateEventDraft(good), null);
});
test("非法 id 被拦", () => {
  const base = { ...adminApi.defaultEventItem(), name: "名字", message: "文案" };
  assert.ok(adminApi.validateEventDraft({ ...base, id: "有中文" }));
  assert.ok(adminApi.validateEventDraft({ ...base, id: "" }));
  assert.strictEqual(adminApi.validateEventDraft({ ...base, id: "ok-id" }), null);
});
test("handler 不在白名单被拦", () => {
  const base = { ...adminApi.defaultEventItem(), id: "ok-id", name: "名字", message: "文案" };
  assert.ok(adminApi.validateEventDraft({ ...base, handler: "nope" }));
  assert.strictEqual(adminApi.validateEventDraft({ ...base, handler: "treasure", relatedTag: "t" }), null);
});
test("treasure 缺 relatedTag 被拦", () => {
  const base = { ...adminApi.defaultEventItem(), id: "ok-id", name: "名字", message: "文案", handler: "treasure", relatedTag: "" };
  assert.ok(adminApi.validateEventDraft(base));
});
test("probability 越界被拦", () => {
  const base = { ...adminApi.defaultEventItem(), id: "ok-id", name: "名字", message: "文案" };
  assert.ok(adminApi.validateEventDraft({ ...base, probability: 0 }));
  assert.ok(adminApi.validateEventDraft({ ...base, probability: 2 }));
  assert.strictEqual(adminApi.validateEventDraft({ ...base, probability: 0.5 }), null);
});
test("message 为空被拦（事件一定要有话说）", () => {
  const base = { ...adminApi.defaultEventItem(), id: "ok-id", name: "名字" };
  assert.ok(adminApi.validateEventDraft({ ...base, message: "   " }));
});
test("泡泡区间反了被拦", () => {
  const base = { ...adminApi.defaultEventItem(), id: "ok-id", name: "名字", message: "文案", params: { min: 20, max: 5 } };
  assert.ok(adminApi.validateEventDraft(base));
});

console.log(`\n----\nadmin-events-page.test: PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
