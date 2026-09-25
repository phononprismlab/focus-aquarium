// 景深 + 未专注毛玻璃。
//
// 两条需求：
//   ① 背景上加一层模糊（现在细节全挤在一个平面里，没有景深）
//   ② 未开始专注时整个鱼缸罩毛玻璃，想看清自己的鱼缸就要打开计时
//
// 实现上最容易做错的两点，这里都锁住：
//   - 背景必须挪到独立的一层（.tank-bg）再模糊。还铺在 .tank 上的话，一模糊连鱼一起糊。
//   - 毛玻璃的 z-index 必须**算过**：压住鱼/草/沙/气泡，但让开海报标题和计时器。
//     该清楚的是字，该朦胧的是缸。
//
// 运行：node test/tank-depth.test.js
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
  if (a === e) { console.log(`PASS | ${name} = ${String(a).slice(0, 80)}`); pass++; }
  else { console.log(`FAIL | ${name} 期望=${String(e).slice(0, 100)} 实际=${String(a).slice(0, 100)}`); fail++; }
}
function chkTrue(name, condition) {
  if (condition) { console.log(`PASS | ${name}`); pass++; }
  else { console.log(`FAIL | ${name}`); fail++; }
}
// 把规则体里的 `: ` / `; ` 压成 `:` / `;`，这样断言只关心属性名和值，不关心作者敲了几个空格。
function rule(selector) {
  const match = source.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1].replace(/:\s+/g, ":").replace(/;\s+/g, ";").trim() : "";
}
// 做"存在性"断言用的紧凑版：只压 CSS 里的空白，让断言不必去数作者敲了几个空格。
const compact = source.replace(/:\s+/g, ":").replace(/;\s+/g, ";").replace(/\s*\{\s*/g, "{").replace(/\s*\}\s*/g, "}");

function zOf(selector) {
  // ⚠️ 必须在**剥掉 @media** 的源码上量：2026-09-25 新增的手机横屏断点里也写了
  // `.v02-topbar{...}`，它排在文件更前面，直接全文 match 会先命中那条（没有 z-index）→ 读出 null。
  const match = ruleOfNoMedia(selector).match(/z-index:\s*(-?\d+)/);
  return match ? Number(match[1]) : null;
}
// 剥掉 @media 块后的源码 + 按选择器取规则体。
const noMediaSource = source.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
function ruleOfNoMedia(selector) {
  const match = noMediaSource.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1].replace(/:\s+/g, ":").replace(/;\s+/g, ";").trim() : "";
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

console.log("--- 1. 背景退到独立一层再模糊 ---");
{
  const renderAquarium = extractFunction(source, "renderAquarium");
  chkTrue("先取 .tank-bg 那一层", /const tankBgEl=document\.getElementById\("tankBg"\)/.test(renderAquarium));
  chkTrue("背景值仍然来自 visualForItem（后台配置优先，没变）",
    /const backgroundCss=visualForItem\("backgrounds", data\.background\)\.css;/.test(renderAquarium));
  chkTrue("写到 .tank-bg 上", /if\(tankBgEl\) tankBgEl\.style\.background=backgroundCss;/.test(renderAquarium));
  chkTrue("找不到那一层时退回旧行为（宁可没景深，也不能让背景消失）",
    /else tank\.style\.background=backgroundCss;/.test(renderAquarium));
  // 反向：旧写法是「函数第一件事就把背景铺在 .tank 上」，那种写法没救 —— 一模糊连鱼一起糊。
  chkTrue("旧的 tankEl.style.background=… 写法已消失",
    !/tankEl\.style\.background/.test(renderAquarium));
  chkTrue(".tank-bg 是 .tank 的第一个子元素（在水色和一切前景之下）",
    /<main class="tank" id="tank">\s*<div class="tank-bg" id="tankBg" aria-hidden="true"><\/div>/.test(source));
}
{
  const bg = rule(".tank-bg");
  chkTrue("只模糊背景层", /filter:blur\(3px\)/.test(bg));
  chkTrue("放大 1.05 补掉 blur 的四边透底", /transform:scale\(1\.05\)/.test(bg));
  chkTrue("铺满整缸", /background-size:cover/.test(bg));
  chkTrue("不抢事件", /pointer-events:none/.test(bg));
  chk("在 z 轴最底", zOf(".tank-bg"), 0);
  chkTrue(".tank 仍然 overflow:hidden（放大后的背景要裁掉）", /overflow:hidden/.test(rule(".tank")));
  chkTrue(".tank-bg 是绝对定位铺满", /position:absolute;inset:0/.test(bg));
}

console.log("\n--- 2. 毛玻璃罩：盖住缸，让开字 ---");
{
  const frost = rule(".tank-frost");
  chkTrue("用 backdrop-filter 模糊身后的一切", /backdrop-filter:blur\(3px\)/.test(frost));
  chkTrue("有 -webkit- 前缀（Safari）", /-webkit-backdrop-filter:blur\(3px\)/.test(frost));
  chkTrue("默认透明（靠状态类切换）", /opacity:0/.test(frost));
  chkTrue("不抢「点水面投喂 / 点鱼加速」的手势", /pointer-events:none/.test(frost));
  chkTrue("有过渡（不是硬切）", /transition:opacity/.test(frost));
  chkTrue("未专注时显示", /body:not\(\.focus-running\) \.tank-frost\{opacity:1;?\}/.test(compact));
  chkTrue("罩子挂在 .tank 内部", /<div class="tank-frost" aria-hidden="true"><\/div>\s*<\/main>/.test(source));
}
{
  // z-index 必须夹在"鱼"和"字"之间。这里不写死 50，而是把真实层级读出来比大小。
  const fish = zOf(".fish");
  const plant = zOf(".plant");
  const sand = zOf(".sand");
  const bubbles = zOf(".bubbles");
  const aqPlant = zOf(".aq-plant");
  const frost = zOf(".tank-frost");
  // 2026-09-25：标题从缸里的大海报字搬进顶栏左上角，所以这里改成量顶栏的层级 ——
  // 标题现在挂在顶栏里，顶栏在罩子上面 = 标题不会被糊。
  const title = zOf(".v02-topbar");
  const timer = zOf(".timer");
  chk("各层 z-index 都读到了", [fish, plant, sand, bubbles, aqPlant, frost, title, timer].every(v => Number.isFinite(v)), true);
  chkTrue(`缸里的东西全在罩子下面（鱼${fish} 草${plant} 沙${sand} 气泡${bubbles} 上传水草${aqPlant} < 罩子${frost}）`,
    [fish, plant, sand, bubbles, aqPlant].every(v => v < frost));
  chkTrue(`顶栏（标题所在层）在罩子上面（顶栏${title} > 罩子${frost}）—— 字不该被糊`, title > frost);
  chkTrue(`计时器在罩子上面（计时器${timer} > 罩子${frost}）—— 不然连按钮都糊了`, timer > frost);
}

console.log("\n--- 3. 状态类只由 running 决定 ---");
{
  const fn = extractFunction(source, "syncFocusRunningClass");
  chkTrue("往 body 上打 focus-running", /document\.body\.classList\.toggle\("focus-running", running\)/.test(fn));
  // 只有一个出口：改 running 的地方必须跟着调它，否则罩子会和计时器状态对不上。
  const assignments = [...source.matchAll(/running = (true|false);\s*\n/g)];
  chk("running 的赋值点只有 2 处（开始 / 复位）", assignments.length, 2);
  chkTrue("每处赋值后面都跟着 syncFocusRunningClass()",
    assignments.every(m => {
      const after = source.slice(m.index + m[0].length, m.index + m[0].length + 260);
      return /syncFocusRunningClass\(\);/.test(after);
    }));
  chkTrue("启动时显式对一次初始状态（不指望 CSS 的 :not() 兜住所有入口）",
    /\n  syncTimeStepButtons\(\);\n  \/\/[^\n]*\n  syncFocusRunningClass\(\);/.test(source));
  // 反向：如果谁在别处偷偷改 running 而不调它，上面那条"赋值点只有 2 处"就会失败。
  // （`let … running = false, …` 那行是声明，不算赋值点。）
  chk("没有第三处 running 赋值", (source.match(/\n\s+running\s*=\s*(true|false);/g) || []).length, 2);
}

console.log(`\n===== 景深与毛玻璃测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
