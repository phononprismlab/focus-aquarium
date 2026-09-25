// 回归测试：玩家端可用性三项 —— 手机调时长、三步新手引导、空态/买满态文案。
//
// 三个真实缺口：
// 1) #time 只有 wheel 监听。手机上根本没有滚轮，时长被锁死在 25:00 —— 这是
//    Go/No-Go 第 1 条（新用户能否独立走完第一次专注）的硬阻塞。
// 2) 全库搜不到任何引导代码。新用户进来只看到一个圆泡和三个按钮。
// 3) 商店只有 maxInventory 校验，没有文案层：买满之后点 + 毫无反应像卡住；
//    某个分类没商品时整片空白像页面坏了；泡泡不够要等点了"保存鱼缸"才知道。
//
// 沿用项目约定：能跑真源码就跑真源码（从 index.html 抽取，不手抄实现），
// 只有纯 DOM/CSS 部分才做源码结构断言。
// 运行：node test/player-usability.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// ⚠️ index.html 在 Windows 工作区里是 CRLF（git autocrlf 检出结果），而本文件里的多行正则
// 一律按 LF 写。不归一化的话，断言会因为换行符而不是因为逻辑而失败。
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}
function chkTrue(name, actual) {
  const ok = actual === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}`);
  if (ok) pass += 1;
  else fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  // ⚠️ indexOf("function X(") 会落在 "async function X(" 的中间，把 async 吃掉。
  const isAsync = src.slice(Math.max(0, start - 6), start) === "async ";
  const begin = isAsync ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(begin, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

// 按方括号配对抽出一个数组字面量（GUIDE_STEPS 这类数据）。
function extractArray(src, constName) {
  const key = `const ${constName} = [`;
  const start = src.indexOf(key);
  if (start < 0) throw new Error(`index.html 里找不到 ${constName}`);
  const open = src.indexOf("[", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return JSON.parse(JSON.stringify(evalArray(src.slice(open, i + 1))));
    }
  }
  throw new Error(`${constName} 方括号不配对`);
}
function evalArray(literal) {
  // 纯数据数组，用 Function 求值即可（不引入 eval 的作用域污染）。
  return new Function(`return ${literal}`)();
}

// ===== 1. A1 手机调时长：−/+ 是入口，滚轮只是微调 =====
console.log("--- A1 时长可调：手机上不再被锁死 25:00 ---");
chkTrue("时长区有独立容器 #timeRow", /<div class="time-row" id="timeRow">/.test(source));
chkTrue("有 − 按钮 #timeMinus", /id="timeMinus"/.test(source));
chkTrue("有 + 按钮 #timePlus", /id="timePlus"/.test(source));
chkTrue("两个按钮都在 #timeRow 里（同一行，不是散落别处）",
  source.indexOf('id="timeMinus"') > source.indexOf('id="timeRow"') &&
  source.indexOf('id="timePlus"') > source.indexOf('id="timeRow"') &&
  source.indexOf('id="timeRow"') < source.indexOf('id="time"'));
chkTrue("按钮带无障碍名称", /id="timeMinus"[^>]*aria-label="减少专注时长"/.test(source) && /id="timePlus"[^>]*aria-label="增加专注时长"/.test(source));

// 边界逻辑必须只有一处实现：滚轮和按钮都走 stepFocusMinutes。
console.log("\n--- 边界只写一遍：滚轮与按钮共用 stepFocusMinutes ---");
const wheelBlock = (source.match(/timeEl\.addEventListener\("wheel"[\s\S]*?\}, \{ passive: false \}\);/) || [""])[0];
chkTrue("找到 wheel 监听", wheelBlock.length > 0);
chkTrue("滚轮改走 stepFocusMinutes", /stepFocusMinutes\(e\.deltaY < 0 \? 1 : -1\)/.test(wheelBlock));
chkTrue("滚轮不再自己算 Math.max/min 边界", /Math\.max\(bounds\.min/.test(wheelBlock) === false);
chkTrue("滚轮仍保留 1 分钟微调", /e\.deltaY < 0 \? 1 : -1/.test(wheelBlock));

const stepBody = extractFunction(source, "stepFocusMinutes");
chkTrue("专注中拒绝改时长", /if \(running\) return false;/.test(stepBody));
chkTrue("按钮每次 5 分钟", /const TIME_STEP_MINUTES = 5;/.test(source));
chkTrue("长按 400ms 后开始连续变", /const TIME_HOLD_DELAY_MS = 400;/.test(source));
chkTrue("长按重复间隔 120ms", /const TIME_HOLD_REPEAT_MS = 120;/.test(source));
chkTrue("松手/移出/取消都停止连续变",
  /\["pointerup", "pointercancel", "pointerleave", "lostpointercapture"\]/.test(source));
// 指针按下时已经算过一次，键盘的 click 必须区分开，否则点一下加 10 分钟。
chkTrue("键盘 click 用 detail===0 去重", /if \(e\.detail === 0\) stepFocusMinutes\(delta\)/.test(source));

// 真源码跑边界。
console.log("\n--- stepFocusMinutes 真源码跑边界 ---");
function makeStepper({ min = 25, max = 120, minutes = 25, running = false } = {}) {
  return new Function(`
const FOCUS_CONFIG = { minFocusDuration: ${JSON.stringify(min)}, maxFocusDuration: ${JSON.stringify(max)} };
let minutes = ${minutes}, remaining = minutes * 60, running = ${running};
let renders = 0;
const timeEl = { textContent: "" };
function renderTime(){ renders++; timeEl.textContent = "x"; }
${extractFunction(source, "focusDurationBounds")}
${extractFunction(source, "stepFocusMinutes")}
return { stepFocusMinutes, state: () => ({ minutes, remaining, running, renders }) };
`)();
}
{
  const s = makeStepper();
  chk("+5：25 → 30，remaining 同步", (() => { const ok = s.stepFocusMinutes(5); return [ok, s.state().minutes, s.state().remaining]; })(), [true, 30, 1800]);
  chk("−5：30 → 25", (() => { s.stepFocusMinutes(-5); return s.state().minutes; })(), 25);
  chk("下限：25 再减不动，也不重绘", (() => { const r = s.state().renders; const ok = s.stepFocusMinutes(-5); return [ok, s.state().minutes, s.state().renders === r]; })(), [false, 25, true]);
}
{
  const s = makeStepper({ minutes: 120 });
  chk("上限：120 再加不动", (() => { const ok = s.stepFocusMinutes(5); return [ok, s.state().minutes]; })(), [false, 120]);
}
{
  const s = makeStepper({ minutes: 118 });
  chk("不会越过上限（118+5 夹到 120）", (() => { s.stepFocusMinutes(5); return s.state().minutes; })(), 120);
}
{
  const s = makeStepper({ minutes: 25, running: true });
  chk("专注中 +5 无效", (() => { const ok = s.stepFocusMinutes(5); return [ok, s.state().minutes]; })(), [false, 25]);
}
{
  // 后台把 min/max 配成同一个值 = 时长锁死，按钮不该还能点。
  const s = makeStepper({ min: 30, max: 30, minutes: 30 });
  chk("min=max 时改不动", (() => { const ok = s.stepFocusMinutes(5); return [ok, s.state().minutes]; })(), [false, 30]);
}

console.log("\n--- syncTimeStepButtons：专注中 / 时长锁死时置灰 ---");
function makeSync({ min = 25, max = 120, running = false } = {}) {
  return new Function(`
const FOCUS_CONFIG = { minFocusDuration: ${JSON.stringify(min)}, maxFocusDuration: ${JSON.stringify(max)} };
let running = ${running};
const document = { querySelectorAll: () => globalThis.__btns };
${extractFunction(source, "focusDurationBounds")}
${extractFunction(source, "syncTimeStepButtons")}
return syncTimeStepButtons;
`)();
}
function runSync(opts) {
  globalThis.__btns = [{ disabled: false }, { disabled: false }];
  makeSync(opts)();
  return globalThis.__btns.map(b => b.disabled);
}
chk("空闲态：两个按钮可用", runSync({ running: false }), [false, false]);
chk("专注中：两个按钮都禁用", runSync({ running: true }), [true, true]);
chk("时长锁死（min=max）：都禁用", runSync({ min: 30, max: 30 }), [true, true]);
chkTrue("初始化就同步一次", /syncTimeStepButtons\(\);\n/.test(source));
chkTrue("点开始专注时同步（否则专注中还能改时长）", /durationSeconds = minutes \* 60;\n(?:.*\n)*?    updateDevStatus\(\);\n    syncTimeStepButtons\(\);/.test(source));
chkTrue("专注结束时同步（否则再也改不回来）", /updateDevStatus\(\);\n    syncTimeStepButtons\(\);\n\n    appTitle\.style\.visibility/.test(source));

// 触屏手感：不加这些手机上会有 300ms 延迟和长按选中。
console.log("\n--- 按钮的触屏细节 ---");
const stepRule = (source.match(/\.time-step \{[\s\S]*?\n  \}/) || [""])[0];
chkTrue("找到 .time-step 规则", stepRule.length > 0);
chkTrue("touch-action: manipulation（去掉双击缩放延迟）", /touch-action: manipulation/.test(stepRule));
chkTrue("禁掉长按选中文字", /user-select: none/.test(stepRule));
chkTrue("禁用态有视觉反馈", /\.time-step:disabled/.test(source));
chkTrue("按钮是圆形且固定尺寸（不随文字撑开）", /border-radius: 50%/.test(stepRule) && /flex: 0 0 30px/.test(stepRule));

// 提示文案：HTML 初始值必须和 JS 常量逐字一致，否则首屏会闪一下换句。
console.log("\n--- 空闲提示文案：HTML 与 JS 常量必须一致 ---");
const hintConst = (source.match(/const HINT_IDLE = "([^"]*)";/) || [])[1];
chkTrue("定义了 HINT_IDLE", typeof hintConst === "string" && hintConst.length > 0);
chkTrue("HTML 初始提示与 HINT_IDLE 一致", source.includes(`id="hint">${hintConst}</div>`));
chkTrue("resetFocus 用 HINT_IDLE 而不是另写一句", /hintEl\.textContent = completed \? "棒极了！点击开始开启下次专注" : HINT_IDLE;/.test(source));

// ===== 2. A4 三步新手引导 =====
console.log("\n--- A4 新手引导：三步、可跳过、只出现一次 ---");
chkTrue("引导容器存在", /<div class="guide" id="guide" hidden/.test(source));
chkTrue("聚光洞元素存在", /id="guideSpot"/.test(source));
chkTrue("引导卡片存在", /id="guideCard"/.test(source));
chkTrue("有进度点容器", /id="guideDots"/.test(source));
chkTrue("有跳过按钮", /id="guideSkip">跳过</.test(source));
chkTrue("有下一步按钮", /id="guideNext">下一步</.test(source));

const steps = extractArray(source, "GUIDE_STEPS");
chk("引导正好三步", steps.length, 3);
chk("三步顺序 = 设时长 → 开始专注 → 商店", steps.map(s => s.target), ["#timeRow", "#start", "#shopOpenBtn"]);
for (const step of steps) {
  const id = step.target.replace(/^#/, "");
  chkTrue(`步骤目标在页面里真实存在：${step.target}`, new RegExp(`id="${id}"`).test(source));
}
chkTrue("每步都有标题和正文", steps.every(s => s.title && s.text));
chkTrue("第三步按钮文案改成「开始吧」", /guideIndex === GUIDE_STEPS\.length - 1 \? "开始吧" : "下一步"/.test(source));
chkTrue("目标元素缺失时跳过该步（不指向不存在的地方）",
  /while\(guideIndex < GUIDE_STEPS\.length && !document\.querySelector\(GUIDE_STEPS\[guideIndex\]\.target\)\) guideIndex \+= 1;/.test(source));

// 只弹一次
console.log("\n--- 只弹一次，且不能反复弹 ---");
chkTrue("用 localStorage 记已看过", /const GUIDE_SEEN_KEY = "fishtank_guide_v1";/.test(source));
function makeSeen(store) {
  globalThis.__store = store;
  return new Function(`
const GUIDE_SEEN_KEY = "fishtank_guide_v1";
const localStorage = {
  getItem: k => { if (globalThis.__store.throwOnRead) throw new Error("denied"); return globalThis.__store.data[k] ?? null; },
  setItem: (k, v) => { if (globalThis.__store.throwOnWrite) throw new Error("denied"); globalThis.__store.data[k] = v; }
};
${extractFunction(source, "guideSeen")}
${extractFunction(source, "markGuideSeen")}
return { guideSeen, markGuideSeen };
`)();
}
{
  const api = makeSeen({ data: {} });
  chk("首次打开：没看过", api.guideSeen(), false);
  api.markGuideSeen();
  chk("标记后：已看过", api.guideSeen(), true);
}
{
  const api = makeSeen({ data: {}, throwOnRead: true });
  chk("读不到 localStorage（隐私模式）→ 当已看过，不反复弹", api.guideSeen(), true);
}
{
  const api = makeSeen({ data: {}, throwOnWrite: true });
  chk("写不进去也不能抛错（最多下次再弹）", (() => { try { api.markGuideSeen(); return "no-throw"; } catch (_) { return "threw"; } })(), "no-throw");
}
chkTrue("结束引导时写入已看过标记", /function endGuide\(\)\{\n    markGuideSeen\(\);/.test(source));

// 聚光洞跟随
console.log("\n--- 聚光洞跟随：目标在浮动气泡里，必须逐帧跟 ---");
chkTrue("用 requestAnimationFrame 逐帧更新", /guideFrame = requestAnimationFrame\(updateGuideSpot\);/.test(source));
chkTrue("引导关闭 / 目标消失时停掉循环", /if\(!target \|\| guide\.hidden\)\{ guideFrame = 0; return; \}/.test(source));
chkTrue("结束引导时 cancelAnimationFrame", /if\(guideFrame\) cancelAnimationFrame\(guideFrame\);/.test(source));
chkTrue("聚光洞不拦点击（点空白=下一步）", /\.guide-spot\{[\s\S]*?pointer-events:none/.test(source));
chkTrue("点空白处也能下一步", /if\(e\.target === guide\) nextGuideStep\(\);/.test(source));
chkTrue("窗口尺寸变化后重算卡片位置", /window\.addEventListener\("resize", \(\) => \{ if\(!guide\.hidden\) renderGuideStep\(\); \}\)/.test(source));
chkTrue("目标在屏幕下半部时卡片挪到上方（不盖住要指的地方）",
  /guideCard\.classList\.toggle\("above", rect\.top \+ rect\.height \/ 2 > window\.innerHeight \* 0\.5\)/.test(source));

// 层级：必须在随机事件弹窗之上、配置提示条之下
console.log("\n--- 层级：盖住鱼缸，但不能盖住配置出错提示 ---");
{
  const z = Number((((source.match(/\.guide\{[^}]*\}/) || [""])[0]).match(/z-index:(\d+)/) || [])[1]);
  chkTrue(`引导 z-index 解析成功（=${z}）`, Number.isFinite(z) && z > 0);
  chkTrue("在随机事件弹窗(3300)之上", z > 3300);
  chkTrue("在配置提示条(6000)之下（配置坏了要能看见）", z < 6000);
  chkTrue("hidden 时真的不显示", /\.guide\[hidden\]\{display:none\}/.test(source));
}
chkTrue("配置没拉到时不引导（先让玩家看见提示条）",
  /if\(window\.FISHTANK_DEFAULT_DATA && !guideSeen\(\)\) startGuide\(\);/.test(source));

// 上面都是源码结构断言。引导是个状态机，光看源码看不出「第三步按钮到底变没变」，
// 所以这里用零依赖假 DOM 把整段引导代码跑一遍（不引 jsdom，项目一直是零依赖）。
console.log("\n--- 引导状态机：用假 DOM 真跑一遍 ---");
const guideCodeStart = source.indexOf("const GUIDE_SEEN_KEY");
const guideCodeEnd = source.indexOf("// 无论配置有没有拉到，首屏都必须渲染出来");
chkTrue("能从 index.html 里抽出引导代码块", guideCodeStart > 0 && guideCodeEnd > guideCodeStart);

function makeGuideHarness({ omitTargets = [], seen = false } = {}) {
  const ids = ["guide", "guideSpot", "guideCard", "guideDots", "guideTitle", "guideText", "guideNext", "guideSkip",
    "timeRow", "start", "shopOpenBtn"];
  const nodes = new Map();
  for (const id of ids) {
    if (omitTargets.includes(`#${id}`)) continue;
    nodes.set(id, {
      id, textContent: "", innerHTML: "", hidden: false, attrs: {}, handlers: {}, style: {},
      rect: { left: 10, top: 20, width: 120, height: 40 },
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; v ? this._s.add(c) : this._s.delete(c); }
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
      fire(t, e = {}) { (this.handlers[t] || []).forEach(fn => fn({ target: this, ...e })); },
      getBoundingClientRect() { return this.rect; }
    });
  }
  const store = { data: seen ? { fishtank_guide_v1: "1" } : {} };
  const frames = [];
  const api = new Function(
    "document", "window", "localStorage", "requestAnimationFrame", "cancelAnimationFrame",
    `${source.slice(guideCodeStart, guideCodeEnd)}
return { startGuide, nextGuideStep, endGuide, renderGuideStep, updateGuideSpot, state: () => ({ guideIndex, guideFrame }) };`
  )(
    {
      getElementById: id => nodes.get(id) || null,
      querySelector: sel => (sel.startsWith("#") ? nodes.get(sel.slice(1)) || null : null)
    },
    { innerHeight: 800, addEventListener() {} },
    {
      getItem: k => (k in store.data ? store.data[k] : null),
      setItem: (k, v) => { store.data[k] = v; }
    },
    fn => { frames.push(fn); return frames.length; },
    () => {}
  );
  return { api, nodes, store, frames, flush() { const fn = frames.pop(); if (fn) fn(); } };
}

{
  const h = makeGuideHarness();
  h.api.startGuide();
  chk("开始后容器可见", h.nodes.get("guide").hidden, false);
  chk("第一步标题", h.nodes.get("guideTitle").textContent, "先挑一个专注时长");
  chk("三个进度点、第一个点亮", h.nodes.get("guideDots").innerHTML,
    '<i class="on"></i><i class=""></i><i class=""></i>');
  chk("第一步按钮是「下一步」", h.nodes.get("guideNext").textContent, "下一步");
  chk("第一帧已排队", h.api.state().guideFrame > 0, true);
  h.flush(); // 假 rAF 只排队不自动执行，手动跑一帧
  chk("聚光洞量到了目标尺寸（含 8px 留白）", [h.nodes.get("guideSpot").style.left, h.nodes.get("guideSpot").style.width], ["2px", "136px"]);

  h.api.nextGuideStep();
  chk("第二步标题", h.nodes.get("guideTitle").textContent, "然后开始专注");
  h.api.nextGuideStep();
  chk("第三步标题", h.nodes.get("guideTitle").textContent, "攒够泡泡就装点鱼缸");
  chk("最后一步按钮变成「开始吧」", h.nodes.get("guideNext").textContent, "开始吧");

  h.api.nextGuideStep();
  chk("走完三步自动收起", h.nodes.get("guide").hidden, true);
  chk("收起时写入已看过标记", h.store.data.fishtank_guide_v1, "1");
  chk("收起时停掉逐帧循环", h.api.state().guideFrame, 0);
}
{
  // 点「跳过」等于走完：也要记已看过，否则下次还弹。
  const h = makeGuideHarness();
  h.api.startGuide();
  h.nodes.get("guideSkip").fire("click");
  chk("跳过也收起", h.nodes.get("guide").hidden, true);
  chk("跳过也记已看过（不然下次还弹）", h.store.data.fishtank_guide_v1, "1");
}
{
  // 目标元素不存在时必须跳过那一步，不能指着空气讲解。
  const h = makeGuideHarness({ omitTargets: ["#start"] });
  h.api.startGuide();
  chk("目标缺失的第一步被跳过（#timeRow 在，保留）", h.nodes.get("guideTitle").textContent, "先挑一个专注时长");
  h.api.nextGuideStep();
  chk("中间那步目标不存在 → 直接跳到商店", h.nodes.get("guideTitle").textContent, "攒够泡泡就装点鱼缸");
}
{
  // 已看过的玩家不该再被弹一次。
  const h = makeGuideHarness({ seen: true });
  chkTrue("已看过时 guideSeen() 为真（bootstrapConfig 里据此不启动）", h.store.data.fishtank_guide_v1 === "1");
}
{
  // 逐帧跟随：目标每帧移动时聚光洞要跟着动。
  const h = makeGuideHarness();
  h.api.startGuide();
  const spot = h.nodes.get("guideSpot");
  const before = spot.style.left;
  h.nodes.get("timeRow").rect = { left: 100, top: 300, width: 160, height: 40 };
  h.api.updateGuideSpot();
  chkTrue("目标移动后聚光洞跟着重算", spot.style.left !== before && spot.style.left === "92px");
}

// ===== 3. A3 空态 / 买满态文案 =====
console.log("\n--- A3 商店空态：不再是一整片空白 ---");
chkTrue("有 .v02-empty 样式", /\.v02-empty\{/.test(source));
chkTrue("空态跨满整行（不挤在一个格子里）", /\.v02-empty\{grid-column:1\/-1;/.test(source));
chkTrue("全部为空时的文案", /商店还没上货/.test(source));
chkTrue("单个分类为空时的文案", /这个分类暂时是空的/.test(source));
chkTrue("两种情况文案分开判断", /allItems\.length===0\s*\?/.test(source));

console.log("\n--- A3 买满态：以前点 + 毫无反应像卡住 ---");
chkTrue("算出是否到上限", /const fishAtMax=item\.category==="fish" && previewCount>=item\.maxInventory;/.test(source));
chkTrue("到上限时 + 置灰", /data-plus="\$\{item\.id\}" \$\{fishAtMax\?'disabled':''\}/.test(source));
chkTrue("数量为 0 时 − 置灰", /data-minus="\$\{item\.id\}" \$\{previewCount<=0\?'disabled':''\}/.test(source));
chkTrue("到上限时说明上限条数", /已经养满啦，这个品种最多 \$\{item\.maxInventory\} 条。/.test(source));
chkTrue("置灰按钮有视觉样式", /\.v02-quantity button:disabled\{/.test(source));

console.log("\n--- A3 泡泡不够：当场说差额，不等到点保存 ---");
function makeSettlement({ paid = 0, refund = 0, bubbles = 0 } = {}) {
  globalThis.__el = {
    textContent: "",
    _short: null,
    classList: { toggle(cls, on) { if (cls === "short") globalThis.__el._short = on; } }
  };
  return new Function(`
const TempAquariumData = {};
const PlayerData = { bubbles: ${bubbles} };
function buildSettlement(){ return { paid: ${paid}, refund: ${refund} }; }
const document = { getElementById: () => globalThis.__el };
${extractFunction(source, "renderSettlement")}
return renderSettlement;
`)();
}
{
  const run = opts => { makeSettlement(opts)(); return { text: globalThis.__el.textContent, short: globalThis.__el._short }; };
  chk("够钱：只说需支付，不标红", run({ paid: 100, bubbles: 500 }), { text: "需支付 100 🫧", short: false });
  chk("不够钱：说出还差多少和现有余额", run({ paid: 300, bubbles: 120 }), { text: "需支付 300 🫧　还差 180 🫧（现有 120 🫧）", short: true });
  chk("返还也算进可支配（120+50 够付 150）", run({ paid: 150, refund: 50, bubbles: 120 }), { text: "需支付 150 🫧　可返还 50 🫧", short: false });
  chk("刚好够：不标红", run({ paid: 100, bubbles: 100 }), { text: "需支付 100 🫧", short: false });
  chk("零泡泡新玩家：告诉他泡泡从哪来", run({ paid: 0, bubbles: 0 }), { text: "还没有泡泡 —— 专注满 25 分钟就能攒到 🫧", short: false });
  chk("有泡泡但没选东西：不打扰", run({ paid: 0, bubbles: 80 }), { text: "", short: false });
}
chkTrue("差额行有独立样式（标红）", /\.v02-settlement\.short\{/.test(source));
chkTrue("结算行有 aria-live（读屏会播报）", /id="shopSettlement" aria-live="polite"/.test(source));

// ===== 4. 三项都不能把原有行为弄坏 =====
console.log("\n--- 不回归：原有能力仍在 ---");
chkTrue("滚轮监听仍在（桌面端习惯没丢）", /timeEl\.addEventListener\("wheel"/.test(source));
chkTrue("商店预览图仍带 loading=lazy", /class="v02-preview-img"[^>]*loading="lazy"/.test(source));
chkTrue("专注奖励仍只走服务端结算", /settleFocusReward\(localReward\)\.then\(/.test(source));
chkTrue("商店「装扮中」禁用逻辑未动", /data-preview-action="\$\{item\.id\}" \$\{equipped\?'disabled':''\}/.test(source));

console.log("\n----");
console.log(`player-usability.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
