// 鱼缸大事记：最近 10 次随机事件，玩家能回看事件把鱼缸改成了什么样。
//
// 这里锁三件事：
//   1. 只留 10 条、新的在前、旧的挤出去
//   2. 记录里只有玩家看得懂的三样（时间 / 事件名 / 影响）——
//      instanceId、handler 名、tag 匹配过程都是内部实现，不能漏进 localStorage
//   3. 两条事件入口（在线检测 + 离线回来补算）都要记账，漏一条就会出现"发生了但没记录"
//
// 运行：node test/event-log.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`PASS | ${name} = ${String(a).slice(0, 90)}`); pass++; }
  else { console.log(`FAIL | ${name} 期望=${String(e).slice(0, 110)} 实际=${String(a).slice(0, 110)}`); fail++; }
}
function chkTrue(name, condition) {
  if (condition) { console.log(`PASS | ${name}`); pass++; }
  else { console.log(`FAIL | ${name}`); fail++; }
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}
function extractConst(src, name) {
  const match = src.match(new RegExp(`const ${name} = [^\\n]*;`));
  if (!match) throw new Error(`index.html 里找不到常量 ${name}`);
  return match[0];
}

const code = [
  extractConst(source, "EVENT_LOG_KEY"),
  extractConst(source, "EVENT_LOG_LIMIT"),
  ["escapeHtml", "formatReceiptStamp", "readEventLog", "saveEventLog", "eventLogEntry", "recordEventLog", "renderEventLog"]
    .map(name => extractFunction(source, name)).join("\n")
].join("\n");

function build(seedStore = {}) {
  const store = { ...seedStore };
  const localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; }
  };
  const listEl = { innerHTML: "" };
  const document = { getElementById: (id) => (id === "eventLogList" ? listEl : null) };
  const factory = new Function("localStorage", "document",
    `${code}\nlet eventLog = readEventLog();\nreturn { recordEventLog, renderEventLog, eventLogEntry, readEventLog, get eventLog(){ return eventLog; } };`);
  return { api: factory(localStorage, document), store, listEl };
}

const makeResult = (name, effect) => ({ config: { id: "ev_" + name, name }, effect });
const BASE = Date.UTC(2026, 8, 25, 5, 0);

console.log("--- 1. 只留 10 条，新的在前 ---");
{
  const { api, store } = build();
  for (let i = 0; i < 13; i++) api.recordEventLog(makeResult(`事件${i}`, { bubbles: i }), BASE + i * 1000);
  chk("上限 10 条", api.eventLog.length, 10);
  chk("最新一条在最前", api.eventLog[0].name, "事件12");
  chk("最旧一条被挤出去（事件0/1/2 都不在）", api.eventLog.some(e => ["事件0", "事件1", "事件2"].includes(e.name)), false);
  chk("最后一条是事件3", api.eventLog[9].name, "事件3");
  chk("落盘的是同一份（刷新后还在）", JSON.parse(store.fishtank_event_log_v1).length, 10);
  chk("落盘顺序与内存一致", JSON.parse(store.fishtank_event_log_v1)[0].name, "事件12");
}

console.log("\n--- 2. 记录里只有玩家看得懂的三样 ---");
{
  const { api } = build();
  const result = {
    config: { id: "ev_fish_escape", name: "夜里的涨潮", handler: "fish-escape", relatedTag: "coral", probability: 0.2 },
    effect: {
      lost: [{ instanceId: "fish_instance_1758_abc", name: "红绿灯" }],
      message: "有一条小鱼顺着水流游走了 —— 红绿灯 在别处也会好好的。",
      bubbles: 0
    }
  };
  api.recordEventLog(result, BASE);
  const entry = api.eventLog[0];
  chk("字段集合锁死", Object.keys(entry).sort(), ["at", "bubbles", "lost", "name"]);
  chk("时间 = 事件发生的时刻", entry.at, BASE);
  chk("事件名", entry.name, "夜里的涨潮");
  chk("丢的鱼只留名字", entry.lost, ["红绿灯"]);
  chkTrue("instanceId 没漏进去", JSON.stringify(entry).indexOf("fish_instance_") < 0);
  chkTrue("handler / relatedTag / probability 没漏进去",
    !/handler|relatedTag|probability/.test(JSON.stringify(entry)));
  chkTrue("叙事文案（message）也不进记录 —— 那张小票已经念过一遍了",
    JSON.stringify(entry).indexOf("顺着水流游走") < 0);
}

console.log("\n--- 3. 脏数据兜底 ---");
{
  const { api } = build();
  api.recordEventLog(makeResult("", { bubbles: -5 }), BASE);
  chk("没名字时给个兜底标题", api.eventLog[0].name, "鱼缸里发生了点事");
  chk("负数泡泡归零", api.eventLog[0].bubbles, 0);
  chk("没有 lost 时是空数组", api.eventLog[0].lost, []);
}
{
  const { api } = build();
  api.recordEventLog({ config: { name: "x" }, effect: { bubbles: "7", lost: [{ name: "" }, null, { name: "蓝尾鱼" }] } }, BASE);
  chk("字符串泡泡转成数字", api.eventLog[0].bubbles, 7);
  chk("lost 里的空项与无名项被剔掉", api.eventLog[0].lost, ["蓝尾鱼"]);
}
{
  const { api } = build();
  api.recordEventLog({ config: { name: "只有名字" }, effect: { bubbles: "abc" } }, BASE);
  chk("泡泡解析不了就归零", api.eventLog[0].bubbles, 0);
  chk("result 为 null 也不炸", (() => { try { api.recordEventLog(null, BASE); return true; } catch (_) { return false; } })(), true);
}

console.log("\n--- 4. 读盘容错 ---");
{
  chk("坏 JSON → 空数组", build({ fishtank_event_log_v1: "{不是 json" }).api.eventLog, []);
  chk("存成对象 → 空数组", build({ fishtank_event_log_v1: '{"a":1}' }).api.eventLog, []);
  chk("存成字符串 → 空数组", build({ fishtank_event_log_v1: '"hello"' }).api.eventLog, []);
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ at: i, name: "n" + i, bubbles: 0, lost: [] })));
  chk("盘里超过 10 条时读进来就裁到 10", build({ fishtank_event_log_v1: many }).api.eventLog.length, 10);
  const dirty = JSON.stringify([{ at: 1, name: "ok", bubbles: 0, lost: [] }, null, "x"]);
  chk("数组里的空项被剔掉", build({ fishtank_event_log_v1: dirty }).api.eventLog.length, 1);
}

console.log("\n--- 5. 渲染 ---");
{
  const { api, listEl } = build();
  api.renderEventLog();
  chkTrue("空态有文案", listEl.innerHTML.includes("还没有记录"));
  chkTrue("空态用空态类", listEl.innerHTML.includes("v02-log-empty"));
}
{
  const { api, listEl } = build();
  api.recordEventLog(makeResult("夜里的涨潮", { bubbles: 0, lost: [{ instanceId: "i1", name: "红绿灯" }] }), BASE);
  const html = listEl.innerHTML;
  chkTrue("有事件名", html.includes("夜里的涨潮"));
  chkTrue("有时间", /<span class="v02-log-time">2026-09-25 \d\d:00<\/span>/.test(html));
  chkTrue("丢鱼写清条数和名字", html.includes("失去 1 条 · 红绿灯"));
  chkTrue("用的是记录项样式", html.includes('class="v02-log-item"'));
  chkTrue("只渲染了 1 条", (html.match(/v02-log-item/g) || []).length === 1);
}
{
  const { api, listEl } = build();
  api.recordEventLog(makeResult("水管里的小气泡", { bubbles: 12 }), BASE);
  chkTrue("得泡泡写 +12", listEl.innerHTML.includes("🫧 +12"));
  chkTrue("没丢鱼时不出现「失去」", !listEl.innerHTML.includes("失去"));
}
{
  const { api, listEl } = build();
  api.recordEventLog(makeResult("什么都没发生", {}), BASE);
  chkTrue("没有影响时明说「鱼缸没有变化」", listEl.innerHTML.includes("鱼缸没有变化"));
}
{
  // 事件名来自后台配置，可能带尖括号 —— 直接拼进 innerHTML 会变成标签。
  const { api, listEl } = build();
  api.recordEventLog(makeResult('<img src=x onerror="alert(1)">', { lost: [{ name: "<b>坏名字</b>" }] }), BASE);
  chkTrue("事件名被转义", listEl.innerHTML.includes("&lt;img src=x"));
  chkTrue("鱼名被转义", listEl.innerHTML.includes("&lt;b&gt;坏名字&lt;/b&gt;"));
  chkTrue("没有真的插进标签", !listEl.innerHTML.includes("<img src=x"));
}
{
  const { api } = build();
  chk("列表容器不存在时 renderEventLog 直接返回", (() => {
    try { api.renderEventLog(); return true; } catch (_) { return false; }
  })(), true);
}

console.log("\n--- 6. 静态锚：两条入口都要记账，抽屉里要能看见 ---");
{
  chk("两条事件入口都调 recordEventLog", (source.match(/recordEventLog\(result, now\);/g) || []).length, 2);
  chk("两条入口都记下事件时刻", (source.match(/result\.at = now;/g) || []).length, 2);
  chkTrue("在线检测入口（pickEventResults 那条）记账",
    /pickEventResults\(EVENT_CONFIGS[\s\S]{0,400}?recordEventLog\(result, now\);/.test(source));
  chkTrue("离线补算入口（pickOfflineEventResults 那条）记账",
    /pickOfflineEventResults\(EVENT_CONFIGS[\s\S]{0,400}?recordEventLog\(result, now\);/.test(source));
  chkTrue("打开「我的」时重画一遍", /if\(id === "mineDrawer"\) renderEventLog\(\);/.test(source));
  chkTrue("抽屉里有大事记区块", /<div class="v02-log" id="eventLogBlock">/.test(source));
  chkTrue("抽屉里有列表容器", /<ol class="v02-log-list" id="eventLogList"><\/ol>/.test(source));
  chkTrue("区块标题是「鱼缸大事记」", source.includes("鱼缸大事记"));
  chkTrue("CSS 有列表项样式", /\.v02-log-item\{/.test(source));
  chkTrue("列表最多 230px 高、可滚（10 条不会把抽屉撑爆）",
    /\.v02-log-list\{[^}]*max-height:230px/.test(source) && /\.v02-log-list\{[^}]*overflow-y:auto/.test(source));
  chkTrue("记录键带版本号（将来换结构不会读错老数据）",
    /const EVENT_LOG_KEY = "fishtank_event_log_v1";/.test(source));
}

console.log(`\n===== 鱼缸大事记测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
