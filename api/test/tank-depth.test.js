// 背景层 + 未专注毛玻璃 + 两侧透视虚化 + 计时器光晕。
//
// 现状（2026-10-06 起）：
//   ① 背景写在独立的一层（.tank-bg）上，但**不做模糊** —— 曾经的 blur(3px) + scale(1.05)
//      景深方案把手绘素材糊掉了，dominik 叫停，两个属性一起撤掉。留这一层是为了
//      将来加滤镜时不牵连鱼。
//   ② 未开始专注时整个鱼缸罩毛玻璃，想看清自己的鱼缸就要打开计时。
//   ③ 缸体左右两侧各盖一层 backdrop-filter + mask 的虚化，模拟隔着缸壁看边缘的失焦。
//   ④ 计时器底下垫一层半透明径向光晕（.timer-halo），让圆泡和水色融在一起。
//
// 实现上最容易做错的三点，这里都锁住：
//   - 背景必须写在独立的一层上，不能直接铺在 .tank 上（一改滤镜就连鱼一起改）。
//   - 毛玻璃 / 两侧虚化的 z-index 必须**算过**：压住鱼/草/沙/气泡，但让开标题和计时器。
//     该清楚的是字，该朦胧的是缸。
//   - 光晕**不能**做成 .timer 的伪元素：.timer 自己有 z-index 会建层叠上下文，
//     负 z-index 的伪元素只会画在圆泡背景之上、文字之下，到不了"泡底下"。
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

console.log("--- 1. 背景退到独立一层（且不做景深模糊）---");
{
  const renderAquarium = extractFunction(source, "renderAquarium");
  chkTrue("先取 .tank-bg 那一层", /const tankBgEl=document\.getElementById\("tankBg"\)/.test(renderAquarium));
  chkTrue("背景值仍然来自 visualForItem（后台配置优先，没变）",
    /const backgroundCss=visualForItem\("backgrounds", data\.background\)\.css;/.test(renderAquarium));
  chkTrue("写到 .tank-bg 上", /if\(tankBgEl\) tankBgEl\.style\.background=backgroundCss;/.test(renderAquarium));
  chkTrue("找不到那一层时退回旧行为（宁可少一层，也不能让背景消失）",
    /else tank\.style\.background=backgroundCss;/.test(renderAquarium));
  // 反向：旧写法是「函数第一件事就把背景铺在 .tank 上」，那种写法没救 —— 一模糊连鱼一起糊。
  chkTrue("旧的 tankEl.style.background=… 写法已消失",
    !/tankEl\.style\.background/.test(renderAquarium));
  chkTrue(".tank-bg 是 .tank 的第一个子元素（在水色和一切前景之下）",
    /<main class="tank" id="tank">\s*<div class="tank-bg" id="tankBg" aria-hidden="true"><\/div>/.test(source));
}
{
  const bg = rule(".tank-bg");
  // 2026-10-06：取消景深。blur 把手绘细节糊掉；scale(1.05) 只是为遮 blur 在四边透出的底色，
  // 一并撤掉。两条都写成反向断言，防止有人"顺手把景深加回来"。
  chkTrue("背景层不再模糊（取消景深）", !/filter:blur/.test(bg));
  chkTrue("背景层不再放大 1.05", !/transform:scale/.test(bg));
  chkTrue("铺满整缸", /background-size:cover/.test(bg));
  chkTrue("不抢事件", /pointer-events:none/.test(bg));
  chk("在 z 轴最底", zOf(".tank-bg"), 0);
  // 沙/装饰按 cover 铺满整缸、超出部分从中轴线往两边裁切 —— 全靠 .tank 的 overflow:hidden 兜住。
  chkTrue(".tank 仍然 overflow:hidden（背景超宽 + 沙/装饰中轴裁切都靠它）", /overflow:hidden/.test(rule(".tank")));
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

console.log("\n--- 3. 两侧透视虚化 + 计时器光晕（2026-10-06 新增）---");
{
  // 两侧虚化：一层 backdrop-filter + mask 的覆盖层，糊掉"身后的缸体"。
  // 层级必须夹在「缸里的东西」和「必须清楚的东西」之间：
  //   鱼/草/沙/气泡 < 两侧虚化 < 饲料(99) / 计时器(1000) / 顶栏(1000)
  // —— 反过来（虚化盖住计时器）就是"连按钮都糊了"的严重回归。
  const edge = rule(".tank-edge");
  chkTrue("两侧虚化用 backdrop-filter 糊身后的一切", /backdrop-filter:blur\(/.test(edge));
  chkTrue("有 -webkit- 前缀（Safari）", /-webkit-backdrop-filter:blur\(/.test(edge));
  chkTrue("用 mask 做渐变（否则缸里会留一条硬邦邦的竖缝）", /mask-image:linear-gradient/.test(edge) && /-webkit-mask-image:linear-gradient/.test(edge));
  chkTrue("不抢手势", /pointer-events:none/.test(edge));
  chkTrue("铺满整缸高度", /position:absolute;top:0;bottom:0/.test(edge));
  chkTrue("左右两层分别贴两边", /\.tank-edge\.left\{left:0;?\}/.test(compact) && /\.tank-edge\.right\{right:0;?/.test(compact));
  // 右侧的 mask 方向必须翻过来，否则右边缘会"反着渐强"（中间糊、边上清楚）。
  const right = rule(".tank-edge.right");
  chkTrue("右侧渐变方向翻过来了（to left，不是照抄 to right）",
    /mask-image:linear-gradient\(to left/.test(right) && !/to right/.test(right));
  // 不靠 transform 翻转：backdrop-filter 叠 transform 在部分浏览器上会坐标错位。
  chkTrue("没有用 scaleX(-1) 翻转（会跟 backdrop-filter 打架）", !/scaleX\(-1\)/.test(right));

  const fish = zOf(".fish"), plant = zOf(".plant"), sand = zOf(".sand"), bubbles = zOf(".bubbles");
  const edgeZ = zOf(".tank-edge"), frostZ = zOf(".tank-frost"), pelletZ = zOf(".feed-pellet");
  const timerZ = zOf(".timer"), topbarZ = zOf(".v02-topbar");
  chk("两侧虚化的 z-index 读到了", Number.isFinite(edgeZ), true);
  chkTrue(`两侧虚化在缸内所有东西之上（鱼${fish} 草${plant} 沙${sand} 气泡${bubbles} < 虚化${edgeZ}）—— 不盖住它们就糊不到`,
    [fish, plant, sand, bubbles].every(v => v < edgeZ));
  chkTrue(`两侧虚化在毛玻璃罩之上（罩子${frostZ} < 虚化${edgeZ}）—— 边缘要比整缸更糊`,
    edgeZ > frostZ);
  chkTrue(`饲料(99)与计时器(1000)不被两侧虚化糊掉（虚化${edgeZ} < 饲料${pelletZ} < 计时器${timerZ}）`,
    edgeZ < pelletZ && pelletZ < timerZ);
  chkTrue(`顶栏（标题所在层）也不被糊（顶栏${topbarZ} > 虚化${edgeZ}）`, topbarZ > edgeZ);

  // 光晕：单独一层（不是伪元素 —— .timer 自己建层叠上下文，负 z-index 的伪元素
  // 只会画在圆泡背景之上、文字之下，到不了"泡底下"）。
  const halo = rule(".timer-halo");
  chkTrue("光晕是径向渐变（半透明光晕，不是实心圆）", /background:radial-gradient\(circle/.test(halo));
  chkTrue("光晕带 blur（软边，不是硬圆）", /filter:blur\(/.test(halo));
  chkTrue("光晕不吃手势", /pointer-events:none/.test(halo));
  chkTrue("光晕与圆泡同拍（共用 bubbleFloat，不会从泡上掉下来）", /animation:bubbleFloat/.test(halo));
  const haloZ = zOf(".timer-halo");
  chkTrue(`光晕在圆泡底下（光晕${haloZ} < 计时器${timerZ}）`, haloZ < timerZ);
  chkTrue(`光晕在两侧虚化之上（虚化${edgeZ} < 光晕${haloZ}）—— 不然光晕会被边缘糊掉`, haloZ > edgeZ);
  chkTrue("光晕排在计时器之前（DOM 顺序与层级一致，读代码不歧义）",
    /<div class="timer-halo" aria-hidden="true"><\/div>\s*<section class="timer" id="timer">/.test(source));
  chkTrue("两侧虚化是纯装饰（aria-hidden，不进无障碍树）",
    /<div class="tank-edge left" aria-hidden="true"><\/div>\s*<div class="tank-edge right" aria-hidden="true"><\/div>/.test(source));
}

console.log("\n--- 4. 状态类只由 running 决定 ---");
{
  const fn = extractFunction(source, "syncFocusRunningClass");
  chkTrue("往 body 上打 focus-running", /document\.body\.classList\.toggle\("focus-running", running\)/.test(fn));
  // 只有一个出口：改 running 的地方必须跟着调它，否则罩子会和计时器状态对不上。
  // 2026-10-06 起有 3 处赋值：开始专注 / 恢复上次没做完的专注 / 复位。
  // 后两处分别走 enterFocusRunningUI() 与 syncFocusRunningClass()（前者内部也会调后者）。
  const assignments = [...source.matchAll(/running = (true|false);\s*\n/g)];
  chk("running 的赋值点有 3 处（开始 / 恢复上次专注 / 复位）", assignments.length, 3);
  chkTrue("每处赋值后面都跟着 syncFocusRunningClass()（或 enterFocusRunningUI —— 它内部会调）",
    assignments.every(m => {
      const after = source.slice(m.index + m[0].length, m.index + m[0].length + 500);
      return /syncFocusRunningClass\(\);/.test(after) || /enterFocusRunningUI\(\);/.test(after);
    }));
  chkTrue("enterFocusRunningUI 自己也要对一次状态类（恢复路径靠它）",
    /function enterFocusRunningUI\(\)\{[\s\S]*?syncFocusRunningClass\(\);/.test(compact));
  chkTrue("启动时显式对一次初始状态（不指望 CSS 的 :not() 兜住所有入口）",
    /\n  syncTimeStepButtons\(\);\n  \/\/[^\n]*\n  syncFocusRunningClass\(\);/.test(source));
  // 反向：如果谁在别处偷偷改 running 而不调它，上面那条"赋值点只有 3 处"就会失败。
  // （`let … running = false, …` 那行是声明，不算赋值点。）
  chk("没有第四处 running 赋值", (source.match(/\n\s+running\s*=\s*(true|false);/g) || []).length, 3);
}

console.log(`\n===== 景深与毛玻璃测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
