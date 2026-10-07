// 「今日专注 / 累计」状态条的位置契约（T10/T12 搬家后）。
//
// 历史：右上角 → 计时器正下方（2026-09-25 上午）→ 页面偏底部（2026-09-25 下午）
//       → **底栏**（2026-10-07，T10：顶栏/缸/底栏 三段式，缸体不再被 fixed 顶栏盖住）。
// 所以现在锁的是：
//   1) 三段式结构：顶栏是 .app 的直接子元素、排在 .tank 之前；底栏排在 .tank 之后；
//      🔴 顶栏标签必须保持 `<div class="v02-topbar">` —— 本文件与 player-tank-ui.test.js
//      都用 indexOf 切源码，标签一变 indexOf 返回 -1，两处会以极难懂的方式红掉；
//   2) 统计条是底栏里的普通流式子项：不再绝对定位、不写 top/bottom/left/transform；
//   3) 层级/交互契约不变：顶栏保留 z-index:1000（tank-depth.test.js 读它）、
//      不吃点击、hidden 整块隐藏、无账号时统计隐藏且占位（#focusHint）出现。
//
// 运行：node test/focus-status-position.test.js
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
  if (a === e) { console.log(`PASS | ${name} = ${String(a).slice(0, 100)}`); pass++; }
  else { console.log(`FAIL | ${name} 期望=${String(e).slice(0, 120)} 实际=${String(a).slice(0, 120)}`); fail++; }
}
function chkTrue(name, condition) {
  if (condition) { console.log(`PASS | ${name}`); pass++; }
  else { console.log(`FAIL | ${name}`); fail++; }
}
const compact = source.replace(/:\s+/g, ":").replace(/;\s+/g, ";").replace(/\s*\{\s*/g, "{").replace(/\s*\}\s*/g, "}");
// 把 @media 块整体摘掉，只留基础规则。
const baseSource = source.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
function ruleOf(src, selector) {
  const match = src.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1].replace(/:\s+/g, ":").replace(/;\s+/g, ";").trim() : "";
}
const rule = (selector) => ruleOf(baseSource, selector);
const MEDIA_520 = (source.match(/@media \(max-width:520px\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";

console.log("--- 1. 三段式布局：顶栏 / 缸 / 底栏 ---");
{
  chkTrue("底栏是 .app 的直接子元素，且排在 .tank 之后",
    /<\/main>\s*(?:<!--[\s\S]*?-->\s*)?<footer class="v02-bottombar">/.test(source));
  chkTrue("顶栏是 .app 的直接子元素，且排在 .tank 之前",
    /<div class="v02-topbar">[\s\S]{0,2000}?<main class="tank"/.test(source));
  chkTrue("顶栏不再写在 .tank 内部",
    !source.slice(source.indexOf('<main class="tank"'), source.indexOf('</main>')).includes('class="v02-topbar"'));
  chkTrue("统计条住在底栏里",
    source.slice(source.indexOf('<footer class="v02-bottombar">'), source.indexOf('</footer>')).includes('id="focusStatus"'));
  const topbar = rule(".v02-topbar");
  chkTrue("顶栏不再是 fixed（搬家后是普通流式通栏）", !/position:fixed/.test(topbar));
  chkTrue("顶栏仍是 space-between 左右两端布局", /justify-content:space-between/.test(topbar));
  chkTrue("顶栏保留 z-index:1000（tank-depth.test.js 读它）", /z-index:1000/.test(topbar));
  chkTrue(".tank 靠 flex 吃剩余高度",
    /flex:1 1 auto/.test(rule(".tank")) && /min-height:0/.test(rule(".tank")));
  chkTrue("底栏与顶栏同级（z-index:1000）", /z-index:1000/.test(rule(".v02-bottombar")));
}

console.log("\n--- 2. 统计条：底栏里的流式子项 ---");
{
  const focus = rule(".v02-focus");
  chkTrue("不再绝对/固定定位（由底栏 flex 居中）", !/position:(absolute|fixed)/.test(focus));
  chkTrue("不再自己写水平/贴底定位", !/left:50%|translateX\(-50%\)|bottom:/.test(focus));
  chkTrue("没有残留的 top", !/(^|[;{])top:/.test(focus));
  chkTrue("内容居中排列", /align-items:center/.test(focus));
  // 反向：更早的旧写法。
  chkTrue("旧的 right:18px 已消失", !/right:18px/.test(focus));
  chkTrue("旧贴计时器的 calc(53% + …) 已消失", !/53%/.test(focus));
  chkTrue("旧的 align-items:flex-end 已消失", !/align-items:flex-end/.test(focus));
}

console.log("\n--- 3. 手机横屏不打架 ---");
{
  const landscape = (source.match(/@media \(orientation: landscape\) and \(max-height: 560px\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";
  chkTrue("有手机横屏断点", landscape.length > 0);
  const landTimer = (landscape.match(/\.timer\{([^}]*)\}/) || [])[1] || "";
  chkTrue("横屏计时器按视口高度取尺寸（vh，不是 vw）", /min\(\d+px,\d+vh\)/.test(landTimer));
  chkTrue("横屏计时器不超过视口一半高（上下还留得下顶栏和底栏）",
    Number((landTimer.match(/min\(\d+px,(\d+)vh\)/) || [])[1] || 100) <= 60);
  const landBar = (landscape.match(/\.v02-bottombar\{([^}]*)\}/) || [])[1] || "";
  const landBarMinH = Number((landBar.match(/min-height:(\d+)px/) || [])[1] || 999);
  chkTrue("横屏底栏压缩档 min-height ≤ 44px", landBarMinH <= 44, `min-height=${landBarMinH}px`);
  // 520px 断点里不该有 .v02-focus 的偏移规则（搬家后它没有可偏移的定位）。
  chkTrue("520px 断点里没有残留的 .v02-focus 偏移规则", !/\.v02-focus\{/.test(MEDIA_520));
  chkTrue("520px 断点仍然在（小屏计时器尺寸照旧）", /@media \(max-width:520px\)/.test(source) && /min\(230px,62vw\)/.test(MEDIA_520));
}

console.log("\n--- 4. 层级与交互契约没变 ---");
{
  const focus = rule(".v02-focus");
  chkTrue("仍然不吃点击（纯展示）", /pointer-events:none/.test(focus));
  chkTrue("hidden 时仍然整块隐藏", /\.v02-focus\[hidden\]\{display:none;\}/.test(compact));
  chkTrue("只读展示四个聚合字段，没引入明细",
    /todayEl\.textContent = `今日专注 \$\{focusStats\.focusCountToday\} 次 · \$\{focusStats\.focusMinutesToday\} 分钟`/.test(source)
    && /totalEl\.textContent = `累计 \$\{focusStats\.focusCount\} 次 · \$\{focusStats\.focusMinutesTotal\} 分钟`/.test(source));
  chkTrue("没账号时 #focusStatus 隐藏且 #focusHint 显示",
    /el\.hidden = true;\s*\n\s*if\(hint\) hint\.hidden = false;/.test(source));
  const retrySlice = source.slice(source.indexOf('getElementById("focusHintRetry")'), source.indexOf('getElementById("focusHintRetry")') + 900);
  chkTrue("占位可点重试：#focusHintRetry 重新拉账号与统计",
    /getElementById\("focusHintRetry"\)/.test(source) && /ensureAccount\(\)/.test(retrySlice) && /refreshFocusStats\(\)/.test(retrySlice));
  chkTrue("启动时渲染一次统计（否则建号失败的玩家看不到占位）",
    (source.match(/(?<!function )renderFocusStats\(\)/g) || []).length >= 2);
}

console.log(`\n===== 专注状态条位置测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
