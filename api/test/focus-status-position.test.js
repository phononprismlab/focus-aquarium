// 「今日专注 / 累计」状态条的位置契约。
//
// 历史：右上角 → 计时器正下方（2026-09-25 上午）→ **页面偏底部**（2026-09-25 下午，dominik：
// 「中段只放计时器，这块看着碍事」）。所以现在锁的是：
//   1) 贴底、居中、且**不能写 top** —— absolute 同时给 top 和 bottom 时 top 会赢，贴底会静默失效；
//   2) 手机横屏下计时器按 vh 取尺寸、状态条贴底，两者各占一端不重叠；
//   3) 层级/交互契约不变（在毛玻璃罩之上、不吃点击、无账号隐藏）。
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
// 不摘的话 .v02-focus 会先匹配到断点里的那条覆盖规则（它在文件里排在前面）。
const baseSource = source.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
function ruleOf(src, selector) {
  const match = src.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1].replace(/:\s+/g, ":").replace(/;\s+/g, ";").trim() : "";
}
const rule = (selector) => ruleOf(baseSource, selector);
const MEDIA_520 = (source.match(/@media \(max-width:520px\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";

console.log("--- 1. 位置：页面偏底部（中段只留计时器） ---");
{
  const focus = rule(".v02-focus");
  chkTrue("水平居中", /left:50%/.test(focus) && /transform:translateX\(-50%\)/.test(focus));
  chkTrue("纵向贴底", /bottom:max\(\d+px,\d+\.?\d*vh\)/.test(focus));
  // 🔴 同时写 top 和 bottom 时 top 会赢 —— 贴底就会失效，这条是防回退的关键。
  chkTrue("没有残留的 top（有 top 会把贴底顶掉）", !/(^|[;{])top:/.test(focus));
  chkTrue("内容改为居中排列（原来是靠右）", /align-items:center/.test(focus));
  // 反向：旧写法是钉在右上角 / 贴在计时器下面。
  chkTrue("旧的 right:18px 已消失", !/right:18px/.test(focus));
  chkTrue("旧贴计时器的 calc(53% + …) 已消失", !/53%/.test(focus));
  chkTrue("旧的 align-items:flex-end 已消失", !/align-items:flex-end/.test(focus));
}
{
  const dom = source.slice(source.indexOf('<section class="timer" id="timer">'), source.indexOf('id="completionFlash"'));
  chkTrue("状态条在 .timer 之后", dom.indexOf('id="focusStatus"') > dom.indexOf("</section>"));
  chkTrue("状态条在专注完成弹窗之前", dom.indexOf('id="focusStatus"') >= 0 && dom.indexOf('id="focusStatus"') < dom.indexOf('class="completion-flash"'));
  const topbar = source.slice(source.indexOf('<div class="v02-topbar">'), source.indexOf('<!-- 音频控件已收进'));
  chkTrue("顶栏区块里确实没有它了", !topbar.includes("focusStatus"));
}

console.log("\n--- 2. 手机横屏不打架 ---");
{
  // 横屏下 vw 很大、vh 很小：计时器必须按 vh 取尺寸，否则会撑出屏幕；
  // 状态条贴底后两者各占一端，不会再叠在一起。
  const landscape = (source.match(/@media \(orientation: landscape\) and \(max-height: 560px\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";
  chkTrue("有手机横屏断点", landscape.length > 0);
  const landTimer = (landscape.match(/\.timer\{([^}]*)\}/) || [])[1] || "";
  chkTrue("横屏计时器按视口高度取尺寸（vh，不是 vw）", /min\(\d+px,\d+vh\)/.test(landTimer));
  chkTrue("横屏计时器不超过视口一半高（上下还留得下顶栏和状态条）",
    Number((landTimer.match(/min\(\d+px,(\d+)vh\)/) || [])[1] || 100) <= 60);
  const landFocus = (landscape.match(/\.v02-focus\{([^}]*)\}/) || [])[1] || "";
  chkTrue("横屏状态条也贴底（且不写 top）", /bottom:\d+px/.test(landFocus) && !/(^|[;{])top:/.test(landFocus));
  // 520px 断点里不该再留着「跟着计时器偏移」的旧规则。
  chkTrue("520px 断点里没有残留的 .v02-focus 偏移规则", !/\.v02-focus\{/.test(MEDIA_520));
  chkTrue("520px 断点仍然在（小屏计时器尺寸照旧）", /@media \(max-width:520px\)/.test(source) && /min\(230px,62vw\)/.test(MEDIA_520));
}

console.log("\n--- 3. 层级与交互契约没变 ---");
{
  const focus = rule(".v02-focus");
  chkTrue("仍然在毛玻璃罩之上（z-index 1000 > 罩子 50）", /z-index:1000/.test(focus));
  chkTrue("仍然不吃点击（纯展示）", /pointer-events:none/.test(focus));
  chkTrue("hidden 时仍然整块隐藏", /\.v02-focus\[hidden\]\{display:none;\}/.test(compact));
  chkTrue("只读展示四个聚合字段，没引入明细",
    /todayEl\.textContent = `今日专注 \$\{focusStats\.focusCountToday\} 次 · \$\{focusStats\.focusMinutesToday\} 分钟`/.test(source)
    && /totalEl\.textContent = `累计 \$\{focusStats\.focusCount\} 次 · \$\{focusStats\.focusMinutesTotal\} 分钟`/.test(source));
  chkTrue("没有账号（没令牌）时保持隐藏",
    /if\(!CLOUD_SYNC_ENABLED \|\| !ACCOUNT_TOKEN\)\{ el\.hidden = true; return; \}/.test(source));
}

console.log(`\n===== 专注状态条位置测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
