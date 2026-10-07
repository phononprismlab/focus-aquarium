// 设置面板（dominik 2026-10-07 反馈）。
//
// 锁四件事：
//   1) 三个小标题（「声音」「画面」「关于」）连同样式一起下线，分区靠 border-top 保持；
//   2) 静音只由右边那个按键触发 —— 那行不能再是 <label>（label 会把点击转给内部的 button），
//      并且音量图标要居中（#settingsDrawer 里那条 justify-content:initial 的污染规则必须放过它）；
//   3) 画面区新增「泡泡动画」「泡泡计时器动画」两个开关，各自落到 body 上的一个类，
//      偏好进 SaveData.Settings（跨设备同步）；
//   4) 「品牌故事」入口与 about-note 一起下线（连 ABOUT_MAP 里的映射也清掉）。
//
// 反向验证：把静音行改回 <label for="audioToggle"> → 第 2 节红；
//          把 :not(.audio-toggle) 去掉 → 第 2 节红；
//          把两个新开关的 CSS 或 applyVisualPrefs 删掉 → 第 3 节红。
//
// 运行：node api/test/settings-panel.test.js   （或归入 run-unit.mjs 从仓库根跑）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..", "..");
const source = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8").replace(/\r\n/g, "\n");
// 禁忌/残留类断言一律剥掉注释再判：改动说明里会写到这些名字，直接在原文里搜会误报。
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const compact = source.replace(/:\s+/g, ":").replace(/;\s+/g, ";").replace(/\s*\{\s*/g, "{").replace(/\s*\}\s*/g, "}");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`PASS | ${name} = ${String(a).slice(0, 90)}`); pass++; }
  else { console.log(`FAIL | ${name} 期望=${String(e).slice(0, 110)} 实际=${String(a).slice(0, 110)}`); fail++; }
}
function chkTrue(name, condition, detail = "") {
  if (condition) { console.log(`PASS | ${name}${detail ? ` (${detail})` : ""}`); pass++; }
  else { console.log(`FAIL | ${name}${detail ? ` (${detail})` : ""}`); fail++; }
}
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`函数 ${name} 的大括号没有配平`);
}

console.log("--- 1. 三个小标题下线（HTML + CSS 一起清）---");
{
  chk("没有「声音」小标题", /audio-settings-title/.test(codeOnly), false);
  chk("没有「画面」小标题", /settings-block-title/.test(codeOnly), false);
  chk("没有「关于」小标题", /about-title/.test(codeOnly), false);
  // 分区没丢：两个 block 仍各有一条 border-top 当分隔线。
  chkTrue("画面区仍有 border-top 分隔", /\.settings-block \{[^}]*border-top/.test(compact) || /\.settings-block\{[^}]*border-top/.test(compact));
  chkTrue("关于区仍有 border-top 分隔", /\.about-block\{[^}]*border-top/.test(compact));
}

console.log("\n--- 2. 静音：仅按键生效 + 图标居中 ---");
{
  // 那行不能再是 <label>：label 会把点击转给它标注的控件（button 也是 labelable）。
  chk("静音行不是 <label>", /<label class="settings-row" for="audioToggle">/.test(source), false);
  chkTrue("静音行是 div（点了不触发静音）",
    /<div class="settings-row settings-row-static">[\s\S]{0,300}id="audioToggleLabel"/.test(source));
  chkTrue("不可点的行去掉指针手型", /\.settings-row-static \{ cursor: default; \}/.test(source));
  chkTrue("静音按钮本身还在（onclick 由 JS 挂）", /<button type="button" class="audio-toggle" id="audioToggle"/.test(source));
  chkTrue("静音按钮仍有 title / aria", /id="audioToggle" aria-label="静音" title="静音 \/ 取消静音"/.test(source));

  // 污染规则必须放过 .audio-toggle，否则它的 justify-content 被改成 initial → 图标贴左。
  chkTrue("抽屉里的污染规则排除了 .audio-toggle",
    /#settingsDrawer \.audio-controls button:not\(\.audio-toggle\)\{justify-content:initial;\}/.test(compact));
  chkTrue("静音按钮自己写明居中",
    /#settingsDrawer \.audio-toggle\{[^}]*justify-content:center/.test(compact));

  const setMuted = extractFunction(source, "setAudioMuted");
  chkTrue("setAudioMuted 仍由按钮点击驱动", /audioToggle\.addEventListener\("click"/.test(source) && /setAudioMuted\(!audioMuted\)/.test(source));
  chkTrue("静音文案切换逻辑保留", /全部声音 · 已静音/.test(setMuted));
}

console.log("\n--- 3. 画面区新增两个开关 ---");
{
  chkTrue("有「泡泡动画」开关（真 checkbox）", /<input type="checkbox" id="bubblesToggle" checked>/.test(source));
  chkTrue("有「泡泡计时器动画」开关（真 checkbox）", /<input type="checkbox" id="timerAnimToggle" checked>/.test(source));
  chkTrue("两个开关都用 .settings-row + .switch（跟缸顶灯光同一套）",
    /<label class="settings-row" for="bubblesToggle">/.test(source) && /<label class="settings-row" for="timerAnimToggle">/.test(source)
    && (source.match(/class="switch-track" aria-hidden="true"/g) || []).length === 3);

  chkTrue("泡泡动画关掉 = 整层隐藏",
    /body\.bubbles-off \.bubbles \{ display: none; \}/.test(source));
  chkTrue("计时器动画关掉 = 圆泡与光晕一起静止",
    /body\.timer-still \.timer, body\.timer-still \.timer-halo \{ animation: none; \}/.test(source));
  chkTrue("静止后仍居中（靠基础 transform，不靠动画的 100% 帧）",
    /\.timer-halo \{[\s\S]{0,400}transform: translate\(-50%, -50%\);/.test(source)
    && /\.timer \{[\s\S]{0,400}transform: translate\(-50%, -50%\);/.test(source));

  const bubblesOn = extractFunction(source, "bubblesAnimEnabled");
  const timerOn = extractFunction(source, "timerAnimEnabled");
  chkTrue("缺字段 = 默认开（老存档升级后不会突然变安静）", /bubbles === false/.test(bubblesOn));
  chkTrue("计时器动画同样默认开", /timerAnim === false/.test(timerOn));

  const apply = extractFunction(source, "applyVisualPrefs");
  chkTrue("applyVisualPrefs 切 bubbles-off", /classList\.toggle\("bubbles-off"/.test(apply));
  chkTrue("applyVisualPrefs 切 timer-still", /classList\.toggle\("timer-still"/.test(apply));
  chkTrue("applyVisualPrefs 同步两个勾选状态（跨设备拉回后 UI 要跟上）",
    /\.checked = bubblesOn/.test(apply) && /\.checked = timerOn/.test(apply));
  // 🔴 现查 DOM、不闭包引用外层 const：applyCloudSave 定义在这些 const 之前。
  chkTrue("applyVisualPrefs 每次现查 DOM（避开 applyCloudSave 的 TDZ）",
    /document\.getElementById\("bubblesToggle"\)/.test(apply) && /document\.getElementById\("timerAnimToggle"\)/.test(apply));

  chkTrue("勾选变化写进 Settings（两个 key）",
    /\[\["bubblesToggle", "bubbles"\], \["timerAnimToggle", "timerAnim"\]\]/.test(source)
    && /SaveData\.Settings\[key\] = toggle\.checked/.test(source));
  chkTrue("勾选变化会落盘并排云推送（走 saveGame，不是只写 localStorage）",
    /SaveData\.Settings\[key\] = toggle\.checked;[\s\S]{0,160}saveGame\(\);/.test(source));
  chkTrue("拉回云存档后重算画面偏好",
    /if\(typeof applyVisualPrefs === "function"\) applyVisualPrefs\(\);/.test(source));
}

console.log("\n--- 4. 品牌故事与 about-note 下线 ---");
{
  chk("HTML 里没有 about-story 入口", /about-story/.test(codeOnly), false);
  chk("HTML/CSS 里没有 about-note", /about-note/.test(codeOnly), false);
  chkTrue("ABOUT_MAP 里没有 story 映射",
    !/story/.test((source.match(/const ABOUT_MAP = \{[^}]*\};/) || [""])[0]));
  chkTrue("其余 4 个入口一个不少",
    ["about-terms", "about-privacy", "about-tip", "about-filing", "about-contact"]
      .every(id => source.includes(`id="${id}"`)));
  // wireAbout 是按 ABOUT_MAP 遍历挂 onclick 的，映射少了 story 就不会渲染它。
  chkTrue("wireAbout 按 ABOUT_MAP 遍历（少了映射自然不渲染）",
    /Object\.keys\(ABOUT_MAP\)\.forEach/.test(source));
}

console.log(`\n==== settings-panel: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
