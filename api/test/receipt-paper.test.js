// 购买小票和事件小票必须是**同一张纸**：同一个锯齿轮廓、同一个抬头、同一排条码。
// 以前两处各写各的 CSS（.v02-receipt-card / .v02-event-card），改一处忘一处。
//
// 这里锁的关键实现决定（都是踩过才知道的）：
//   1. 上下两边都要锯齿 → clip-path 的 polygon 必须同时出现 8px（上）和 calc(100% - 8px)（下）
//   2. 阴影只能挂在父层 .v02-paper-shadow 上：clip-path 会把同一元素上的 box-shadow 一起裁掉
//   3. 弹窗要 overflow:auto + 纸用 margin:auto 居中，否则票比屏幕高时顶端滚不上去
//
// 运行：node test/receipt-paper.test.js
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
  if (a === e) {
    console.log(`PASS | ${name} = ${String(a).slice(0, 80)}`);
    pass++;
  } else {
    console.log(`FAIL | ${name} 期望=${String(e).slice(0, 100)} 实际=${String(a).slice(0, 100)}`);
    fail++;
  }
}
function chkTrue(name, condition) {
  if (condition) { console.log(`PASS | ${name}`); pass++; }
  else { console.log(`FAIL | ${name}`); fail++; }
}
function rule(selector) {
  const match = source.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1] : "";
}

console.log("--- 1. 两处小票共用同一张纸 ---");
{
  chkTrue("购买小票是 .v02-paper v02-receipt-card",
    /class="v02-paper v02-receipt-card"/.test(source));
  chkTrue("事件小票是 .v02-paper v02-event-card",
    /class="v02-paper v02-event-card"/.test(source));
  chk("两处都套了阴影层", (source.match(/<div class="v02-paper-shadow">/g) || []).length, 2);
  // 反向：各自为政的旧类名不能复活。
  chkTrue("旧类 .v02-receipt-sub 已消失（抬头改用共享的 .v02-paper-brand）",
    !/class="v02-receipt-sub"/.test(source) && !/\.v02-receipt-sub\{/.test(source));
  chkTrue("旧类 .v02-receipt-line 已消失（改用共享的 .v02-paper-line）",
    !/class="v02-receipt-line"/.test(source) && !/\.v02-receipt-line\{/.test(source));
  chkTrue("旧的两条 ::before 虚线（只画上边那条）已删除",
    !/\.v02-receipt-card::before\{/.test(source) && !/\.v02-event-card::before\{/.test(source));
}

console.log("\n--- 2. 抬头：logo + 店名 + 英文名 ---");
{
  const logos = source.match(/<div class="v02-paper-logo">[\s\S]*?<\/div>/g) || [];
  chk("两处各有一组抬头", logos.length, 2);
  chkTrue("每组抬头都有店标", logos.every(b => b.includes('class="v02-paper-mark"')));
  chkTrue("每组抬头都有中文店名「鱼儿乐水族馆」", logos.every(b => b.includes("鱼儿乐水族馆")));
  chkTrue("每组抬头都有英文名 FOCUS AQUARIUM", logos.every(b => b.includes("FOCUS AQUARIUM")));
  chkTrue("抬头文字在 CSS 里是居中的三行",
    /\.v02-paper-logo\{[^}]*align-items:center/.test(source) && /\.v02-paper-logo\{[^}]*text-align:center/.test(source));
}

console.log("\n--- 3. 上下两边都是锯齿 ---");
{
  // polygon 里带 calc(100% - 8px)，所以不能用 [^)]* 去圈 —— 会被 calc 的右括号提前截断。
  const notch = (source.match(/--paper-notch:(polygon\([\s\S]*?\));/) || [])[1] || "";
  chkTrue("定义了 --paper-notch", notch.startsWith("polygon("));
  const points = notch.slice(8, -1).split(",");
  chk("65 个点（上边 33 + 下边 32）", points.length, 65);
  chk("起点在左上齿谷", points[0], "0% 8px");
  chk("上边最高点是 0（齿尖顶到纸外沿）", points[1], "3.125% 0");
  chk("上边收在右上齿谷", points[32], "100% 8px");
  chk("下边起点（右）", points[33], "96.875% 100%");
  chk("终点在左下齿谷", points[64], "0% calc(100% - 8px)");
  // 注意：y 值里有 calc(100% - 8px)，不能按空格切。
  const yOf = (point) => (point.match(/^[\d.]+% (.*)$/) || [])[1];
  chk("上边用到的 y 值集合", [...new Set(points.slice(0, 33).map(yOf))].sort(), ["0", "8px"]);
  chk("下边用到的 y 值集合", [...new Set(points.slice(33).map(yOf))].sort(), ["100%", "calc(100% - 8px)"]);
  // 反向：旧的"只有下边锯齿"版本（36 个点、从 0 0 开始）必须已经不存在。
  chkTrue("旧的只在下边开齿的 clip-path 已删除",
    !/clip-path:polygon\(0 0,100% 0,100% 97%/.test(source));
  chkTrue(".v02-paper 用的是这个变量", /\.v02-paper\{[\s\S]*?clip-path:var\(--paper-notch\)/.test(source));
}

console.log("\n--- 4. 阴影挂在父层（clip-path 会吃掉同层的 box-shadow）---");
{
  chkTrue("父层用 filter:drop-shadow", /\.v02-paper-shadow\{[^}]*filter:drop-shadow\(/.test(source));
  chkTrue("纸本身没有 box-shadow（有也会被裁掉，等于白写）",
    !/box-shadow/.test(rule(".v02-paper")));
}

console.log("\n--- 5. 票面更长 + 小屏可滚 ---");
{
  chkTrue("纸有 min-height（内容少的票也有票的长度）", /\.v02-paper\{[\s\S]*?min-height:min\(430px,74vh\)/.test(source));
  chkTrue("纸是 flex 列（条码靠 margin-top:auto 顶到底）", /\.v02-paper\{[\s\S]*?display:flex;flex-direction:column/.test(source));
  chkTrue("条码块 margin-top:auto", /\.v02-paper-barcode\{margin:auto 0 0;/.test(source));
  chkTrue("购买弹窗 overflow:auto", /\.v02-receipt\{[^}]*overflow:auto/.test(source));
  chkTrue("事件弹窗 overflow:auto", /\.v02-event\{[^}]*overflow:auto/.test(source));
  // align-items:center 居中 + overflow:auto 时，票比屏幕高会连顶端一起滚不上去 —— 必须靠 margin:auto。
  chkTrue("阴影层用 margin:auto 居中（可滚的关键）", /\.v02-paper-shadow\{[^}]*margin:auto/.test(source));
}

console.log("\n--- 6. 贴纸（2026-09-25 全部下线） ---");
{
  // dominik：贴纸先都去掉，等以后画了图再贴。这里反向锁住 —— 别哪天又冒出来。
  chk("两张票上都不再有贴纸元素", (source.match(/class="v02-paper-sticker /g) || []).length, 0);
  chkTrue("贴纸的 CSS 也一起删了（不留死代码）", !/\.v02-paper-sticker/.test(source));
  // 贴纸曾经把纸宽压到 calc(100vw - 76px) 给它让位；下线后纸宽应该回到正常的 40px 边距。
  chkTrue("纸宽回到 40px 边距（不再为贴纸让位）", /width:min\(348px,calc\(100vw - 40px\)\)/.test(source));
  chkTrue("没有残留的 76px 让位写法", !/calc\(100vw - 76px\)/.test(source));
}

console.log("\n--- 7. 票面时间 ---");
{
  chkTrue("购买小票有时间元素", /<div class="v02-paper-meta" id="receiptTime"><\/div>/.test(source));
  chkTrue("事件小票有时间元素", /<div class="v02-paper-meta" id="eventModalTime"><\/div>/.test(source));
  chkTrue("成功的票写「购买时间」",
    /document\.getElementById\("receiptTime"\)/.test(source)
    && /\$\{failed \? "小票时间" : "购买时间"\} \$\{formatReceiptStamp\(Date\.now\(\)\)\}/.test(source));
  chkTrue("失败的票改口叫「小票时间」（那次并没有买成）",
    /const failed = String\(title \|\| ""\)\.startsWith\("无法"\)/.test(source));
  chkTrue("事件票写「发生时间」",
    /document\.getElementById\("eventModalTime"\)/.test(source)
    && /`发生时间 \$\{formatReceiptStamp\(result\.at \|\| Date\.now\(\)\)\}`/.test(source));
  // 事件可能排在别的遮罩后面才弹出来，票面时间必须用事件真正发生的时刻。
  chkTrue("事件时刻在 checkEvents 里记下", /result\.at = now;/.test(source));
  chk("两处事件入口都记了（在线 + 离线回来）", (source.match(/result\.at = now;/g) || []).length, 2);
  chkTrue("presentEventResult 优先用 result.at", /formatReceiptStamp\(result\.at \|\| Date\.now\(\)\)/.test(source));
}

console.log("\n--- 8. 事件票上的影响标签 ---");
{
  chkTrue("事件票有影响容器", /<div class="v02-event-impact" id="eventModalImpact" hidden><\/div>/.test(source));
  chkTrue("渲染函数存在", /function renderEventImpact\(effect\)\{/.test(source));
  chkTrue("泡泡用普通标签", /chips\.push\(`<span>🫧 \+\$\{bubbles\}<\/span>`\)/.test(source));
  chkTrue("丢鱼用红色标签", /chips\.push\(`<span class="loss">失去 \$\{lost\.length\} 条 · /.test(source));
  chkTrue("没有影响时整块隐藏", /box\.hidden = chips\.length === 0;/.test(source));
  chkTrue("[hidden] 必须显式 display:none（display:flex 会盖掉 hidden）",
    /\.v02-event-impact\[hidden\]\{display:none;?\}/.test(source));
  chkTrue("presentEventResult 会调它", /renderEventImpact\(result\.effect\)/.test(source));
}

console.log(`\n===== 小票纸测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
