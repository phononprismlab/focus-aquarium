// 「今日专注 / 累计」状态条从右上角挪到计时器下面。
//
// 原因（dominik 2026-09-25）：放右上角，屏幕一长它就飘出视野；贴着计时器走才永远在视线中心附近。
//
// 这里最值得锁的不是"挪了位置"，而是**偏移量必须跟着计时器尺寸走**：
// 状态条是绝对定位的，它的 top 是"计时器中心 + 计时器半高 + 间隙"。
// 计时器尺寸在媒体查询里会变（260px/70vw → 230px/62vw），状态条的偏移必须同步变，
// 否则小屏上会掉到缸底外面。这个测试从 CSS 里把两边的数字读出来自己算，不写死。
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
// 不摘的话 .v02-focus 会先匹配到 520px 断点里的那条覆盖规则（它在文件里排在前面）。
const baseSource = source.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
function ruleOf(src, selector) {
  const match = src.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1].replace(/:\s+/g, ":").replace(/;\s+/g, ";").trim() : "";
}
const rule = (selector) => ruleOf(baseSource, selector);
// 从 `width:min(260px, 70vw)` 里把 260 和 70 抠出来。
function timerSize(css) {
  const match = css.match(/min\((\d+)px,\s*(\d+)vw\)/);
  if (!match) throw new Error(`读不出计时器尺寸：${css}`);
  return { px: Number(match[1]), vw: Number(match[2]) };
}
const MEDIA_520 = (source.match(/@media \(max-width:520px\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";

console.log("--- 1. 位置：从右上角挪到计时器下面 ---");
{
  const focus = rule(".v02-focus");
  chkTrue("水平居中", /left:50%/.test(focus) && /transform:translateX\(-50%\)/.test(focus));
  chkTrue("纵向贴在计时器下方", /top:calc\(53% \+ min\(/.test(focus));
  chkTrue("内容改为居中排列（原来是靠右）", /align-items:center/.test(focus));
  // 反向：旧写法是钉在右上角。
  chkTrue("旧的 right:18px 已消失", !/right:18px/.test(focus));
  chkTrue("旧的 top:62px 已消失", !/top:62px/.test(focus));
  chkTrue("旧的 align-items:flex-end 已消失", !/align-items:flex-end/.test(focus));
}
{
  const dom = source.slice(source.indexOf('<section class="timer" id="timer">'), source.indexOf('id="completionFlash"'));
  chkTrue("状态条在 .timer 之后", dom.indexOf('id="focusStatus"') > dom.indexOf("</section>"));
  chkTrue("状态条在专注完成弹窗之前", dom.indexOf('id="focusStatus"') >= 0 && dom.indexOf('id="focusStatus"') < dom.indexOf('class="completion-flash"'));
  const topbar = source.slice(source.indexOf('<div class="v02-topbar">'), source.indexOf('<!-- 音频控件已收进'));
  chkTrue("顶栏区块里确实没有它了", !topbar.includes("focusStatus"));
}

console.log("\n--- 2. 偏移量跟着计时器尺寸走 ---");
{
  const timer = timerSize(rule(".timer"));
  chk("基准尺寸", [timer.px, timer.vw], [260, 70]);
  // 半高：260/2 = 130，70vw/2 = 35vw
  const expected = `${timer.px / 2}px,${timer.vw / 2}vw`;
  chk("状态条用的半高与计时器一致", (rule(".v02-focus").match(/min\((\d+px,\d+vw)\)/) || [])[1], expected);
  chkTrue("还留了间隙给 bubbleFloat 的浮动幅度",
    /top:calc\(53% \+ min\(130px,35vw\) \+ \d+px\)/.test(compact));
}
{
  // 媒体查询里计时器会缩小，状态条必须跟着缩 —— 这条不写死，直接从两处 CSS 里读出来比。
  const smallTimer = timerSize((MEDIA_520.match(/\.timer\{([^}]*)\}/) || [])[1] || "");
  chk("小屏计时器尺寸", [smallTimer.px, smallTimer.vw], [230, 62]);
  const smallFocus = (MEDIA_520.match(/\.v02-focus\{([^}]*)\}/) || [])[1] || "";
  chkTrue("小屏上状态条的偏移同步缩小",
    smallFocus.includes(`min(${smallTimer.px / 2}px,${smallTimer.vw / 2}vw)`));
  chkTrue("小屏规则写在 520px 断点里（和计时器同一条断点）",
    /@media \(max-width:520px\)/.test(source) && /\.v02-focus\{top:calc\(/.test(MEDIA_520.replace(/\s+/g, "").replace(/:\s+/g, ":")));
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
