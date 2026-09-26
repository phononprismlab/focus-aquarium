// 回归测试：2026-09-25 下午「鱼儿乐」页面批量改造。
//
// 覆盖（dominik 逐条提的 15 项里能落到代码上的部分）：
//   1) 大标题收进顶栏左上角、泡泡移到右上角「装点」旁边；
//   2) 开始/结束 = 圆形播放/停止泡泡按钮，旧青绿统一换成规定的蓝；
//   3) 专注中状态行「专注中 · 已进行 N 分钟，完成后预计获得 M 泡泡」；
//   4) 状态条贴页面底部（中段只留计时器）；
//   5) 沙子上传透明底 PNG 按高度撑满（否则沙子完全不显示）；
//   6) 专注中点顶栏按钮不该掉饲料；
//   7) 蓝尾鱼「关掉投喂反应后看不见」—— 旧相对路径被当成图片插槽 → 404 空鱼；
//   8) 商品描述限制两行；
//   9) 图标按钮都有 title + aria-label；
//  10) 背景图尺寸标准写进后台提示。
//
// 运行：node test/player-tank-ui.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..", "..");
const source = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8").replace(/\r\n/g, "\n");
const adminSource = fs.readFileSync(path.join(projectRoot, "admin.html"), "utf8").replace(/\r\n/g, "\n");

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
const compact = source.replace(/:\s+/g, ":").replace(/;\s+/g, ";").replace(/\s*\{\s*/g, "{").replace(/\s*\}\s*/g, "}");
// 禁忌色值类断言必须剥掉注释再判：本轮把「旧青绿已退役」写进了注释，直接在原文里搜会误报。
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const baseSource = source.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
const rule = (selector) => {
  const match = baseSource.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return match ? match[1].replace(/:\s+/g, ":").replace(/;\s+/g, ";").trim() : "";
};
// 按大括号配对抽出整个函数体（index.html 里的函数都在同一个 IIFE 里，逐层数括号最稳）。
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`函数 ${name} 的大括号没配对`);
}

// ===== 1. 顶栏：标题收进左上角、泡泡移到右上角 =====
console.log("--- 1. 顶栏 ---");
{
  const topbar = source.slice(source.indexOf('<div class="v02-topbar">'), source.indexOf('<!-- 音频控件已收进'));
  chkTrue("标题在顶栏里（id 仍是 appTitle，动画/引用不用改）",
    /<h1 class="v02-brand-title" id="appTitle">鱼儿乐水族馆<\/h1>/.test(topbar));
  chkTrue("缸里的大海报标题已删除", !/<h1 class="poster-title"/.test(source) && !/class="poster-title"/.test(source));
  chkTrue("泡泡数在顶栏右侧、排在「装点」前面",
    /<nav class="v02-topbar-entries">\s*<div class="v02-bubbles" id="bubbleDisplay"[\s\S]{0,200}id="shopOpenBtn"/.test(topbar));
  chkTrue("顶栏是左右两端布局（space-between）", /justify-content:space-between/.test(rule(".v02-topbar")));
  const brand = rule(".v02-brand-title");
  chkTrue("品牌标题不再是绝对定位（已经进文档流）", brand.length > 0 && !/position:absolute/.test(brand));
  // 动画是从「居中大标题」那套继承来的：留着 translateX(-50%) 的话，开始专注时标题会往左飞出去。
  const dissolve = (source.match(/@keyframes bubbleUpDissolve\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";
  const appear = (source.match(/@keyframes bubbleIn\s*\{([\s\S]*?)\n  \}/) || [])[1] || "";
  chkTrue("消散动画里没有 translateX(-50%)", dissolve.length > 0 && !/translateX\(-50%\)/.test(dissolve));
  chkTrue("淡入动画里没有 translateX(-50%)", appear.length > 0 && !/translateX\(-50%\)/.test(appear));
  // 🔴 标题搬进顶栏后不能再「飘走 + 隐藏」：顶栏是固定导航，元素消失会留一个空洞。
  //    实测（真浏览器）专注中顶栏左上角原来是空的。
  chkTrue("消散动画不位移（不写 translate / scale）", dissolve.length > 0 && !/translate|scale\(/.test(dissolve));
  chkTrue("消散动画不整体透明到 0（只是暗下去）", !/opacity:\s*0\s*[;}]/.test(dissolve), dissolve.slice(0, 60));
  chkTrue("淡入动画也不位移", appear.length > 0 && !/translate|scale\(/.test(appear));
  chkTrue("专注中不再把标题整块 visibility:hidden",
    !/appTitle\.style\.visibility\s*=\s*"hidden"/.test(source) && !/appTitle\.style\.visibility\s*=\s*"visible"/.test(source));
}

// ===== 2. 圆形播放 / 停止泡泡按钮 =====
console.log("\n--- 2. 圆形开始/结束按钮 + 配色 ---");
{
  const btn = rule(".start, .end");
  chkTrue("是正圆（border-radius:50%）", /border-radius:50%/.test(btn));
  chkTrue("固定方形尺寸（圆形按钮不能靠 padding 撑）", /width:54px/.test(btn) && /height:54px/.test(btn));
  chkTrue("用规定的蓝（--screen-blue-500 / 700），不是旧青绿",
    /var\(--screen-blue-500\)/.test(btn) && !/#4d8a8c|#667f82/.test(btn));
  chkTrue("旧的青绿在全文件里都清干净了（注释不算）", !/#4d8a8c|#667f82|#5a8588|#4f7d80|#e1eeee/.test(codeOnly));
  chkTrue("开始按钮是播放符号 + 有名字（读屏可识别）",
    /<button class="start" id="start" type="button" aria-label="开始专注" title="开始专注"><span class="start-glyph" aria-hidden="true">▶<\/span>/.test(source));
  chkTrue("结束按钮是停止符号 + 有名字",
    /<button class="end" id="end" type="button" aria-label="结束专注" title="结束专注"><span class="end-glyph" aria-hidden="true">■<\/span>/.test(source));
  chkTrue("JS 切显示用 inline-flex（inline-block 会让图标贴顶）",
    /endBtn\.style\.display = "inline-flex"/.test(source) && /startBtn\.style\.display = "inline-flex"/.test(source));
  chkTrue("结束态用更深的蓝（播放/停止一眼能分开）",
    /\.end\{[^}]*var\(--screen-blue-700\)/.test(compact));
  // 🔴 未专注时「结束」必须藏着：两个圆形泡泡同时露出来玩家不知道点哪个。
  //    基线是 .end{display:none}，重写圆形按钮时丢过一次，靠这条锁住。
  chkTrue("未专注时结束按钮默认隐藏（.end 基础规则 display:none）", /\.end\{[^}]*display:none/.test(compact));
  chkTrue("结束按钮由 JS 写 inline-flex 打开（inline 才能盖过上面的 none）",
    /endBtn\.style\.display = "inline-flex"/.test(source));
}

// ===== 3. 专注中状态行 =====
console.log("\n--- 3. 专注中状态行 ---");
{
  chkTrue("计时器里有 focusProgress 行", /<div class="focus-progress" id="focusProgress" hidden aria-live="polite"><\/div>/.test(source));
  chkTrue("元素引用接上了", /const focusProgressEl = document\.getElementById\("focusProgress"\)/.test(source));
  const fn = extractFunction(source, "updateFocusProgress");
  chkTrue("文案就是「专注中 · 已进行 N 分钟，完成后预计获得 M 泡泡」",
    /`专注中 · 已进行 \$\{elapsedMinutes\} 分钟，完成后预计获得 \$\{planned\} 泡泡`/.test(fn));
  chkTrue("已进行分钟数按 startedAt 实时算", /Math\.floor\(\(Date\.now\(\) - startedAt\) \/ 60000\)/.test(fn));
  chkTrue("预计奖励走 focusRewardMinutes（和结算同一个口径）",
    /focusRewardMinutes\(minutes, PlayerData\.isMember === true\)/.test(fn));
  chkTrue("非专注态自动收起", /if \(!running\) \{ focusProgressEl\.hidden = true; return; \}/.test(fn));
  chkTrue("计时循环里每帧刷新", /renderTime\(\);\n      updateFocusProgress\(\);/.test(source));
  chkTrue("复位时显式收起", /focusProgressEl\.hidden = true;/.test(source.slice(source.indexOf('startBtn.style.display = "inline-flex"'))));
  // 这句话在计时器圆里会折成两行，balance 让两行长度接近（否则断在「预计获得」中间）。
  chkTrue("进度行用 text-wrap:balance（两行长度接近，不在词中间断）",
    /\.focus-progress\{[^}]*text-wrap:balance/.test(compact));
}

// ===== 4. 状态条贴底 =====
console.log("\n--- 4. 状态条位置 ---");
{
  const focus = rule(".v02-focus");
  chkTrue("贴页面底部", /bottom:max\(16px,3\.5vh\)/.test(focus));
  chkTrue("没有残留 top（top 会盖掉 bottom）", !/(^|[;{])top:/.test(focus));
}

// ===== 5. 沙子：按高度撑满 =====
console.log("\n--- 5. 沙子上传图 ---");
{
  const script = source.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
  const re = script.match(/const IMAGE_SOURCE_RE = .*/)[0];
  const css = extractFunction(script, "cssFromImagePath");
  const api = new Function(`${re}\n${css}\nreturn { cssFromImagePath };`)();
  const url = "https://cdn.example.com/a/sand.png";
  const sand = api.cssFromImagePath(url, "sand");
  chkTrue("沙子按高度撑满（auto 100%）", /\/ auto 100%/.test(sand));
  chkTrue("沙子横向平铺（图比屏窄时不露底）", /repeat-x/.test(sand));
  chkTrue("沙子贴底（沙层在底部，不是居中）", /center bottom/.test(sand));
  chkTrue("沙子不再用 cover（cover 会把透明区铺满可见区域 → 沙子看不见）", !/cover/.test(sand));
  chkTrue("背景仍然 cover、装饰仍然 contain（没被误伤）",
    /\/ cover/.test(api.cssFromImagePath(url, "cover")) && /\/ contain/.test(api.cssFromImagePath(url, "contain")));
  chkTrue("沙子单独一档 fit", /const fit = category === "sands" \? "sand" : \(field === "css" \? "cover" : "contain"\)/.test(script));
  chkTrue("上传沙子图时整层拉到整缸高", /\.sand\.sand-image \{ height: 100%; \}/.test(source));
  chkTrue("渲染时按有无上传图切换 class",
    /sandEl\.classList\.toggle\("sand-image", Boolean\(sandVisual\.image\)\)/.test(script));
  chkTrue("沙子层级仍在背景之上、装饰之下（z-index:2）", /\.sand\{[^}]*z-index:2/.test(compact));
}

// ===== 6. 专注中点界面不掉饲料 =====
console.log("\n--- 6. 投喂误触 ---");
{
  const handler = source.slice(source.indexOf('tank.addEventListener("pointerdown"'), source.indexOf('tank.addEventListener("pointerdown"') + 900);
  chkTrue("排除列表里有顶栏", /\.v02-topbar/.test(handler));
  chkTrue("排除任何按钮（图标按钮也走这条路）", /closest\("button, a, input, select, textarea/.test(handler));
  chkTrue("抽屉 / 弹窗 / 小票也排除了",
    /\.v02-drawer/.test(handler) && /\.v02-receipt/.test(handler) && /\.v02-event/.test(handler));
  chkTrue("旧的窄排除列表已消失", !/closest\("\.timer, \.modal, \.audio-controls"\)/.test(source));
}

// ===== 7. 蓝尾鱼：旧相对路径不能再当图片插槽 =====
console.log("\n--- 7. 鱼的资源路径过滤 ---");
{
  const script = source.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
  const re = script.match(/const IMAGE_SOURCE_RE = .*/)[0];
  const fn = extractFunction(script, "fishPartsFromAssembly");
  const api = new Function(`${re}\n${fn}\nreturn { fishPartsFromAssembly };`)();
  chk("旧相对路径（种子鱼）→ 不当图片用，回退 CSS 鱼",
    api.fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "assets/fish/blue-tang.png" }] }), null);
  chk("旧格式字符串数组里的相对路径同样被挡掉",
    api.fishPartsFromAssembly({ resourcePath: ["assets/fish/clownfish.png"] }), null);
  chk("后台上传的绝对图片地址照常拼装",
    api.fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "https://cdn.example.com/fish/a.png" }] }),
    { body: "https://cdn.example.com/fish/a.png" });
  chk("混合时只留可用的那一张（不会因为一张坏路径整条鱼消失）",
    api.fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "assets/fish/old.png" }, { slot: "tail", path: "https://cdn.example.com/fish/t.png" }] }),
    { tail: "https://cdn.example.com/fish/t.png" });
  chk("resourcePath 不是数组 → null（老格式，走 CSS 鱼）", api.fishPartsFromAssembly({ resourcePath: "assets/fish/x.png" }), null);
  chkTrue("后台会提示旧路径在玩家端不生效",
    /旧路径 · 玩家端不生效（回退内置 CSS 鱼）/.test(adminSource) && /FISH_RESOURCE_USABLE_RE/.test(adminSource));
}

// ===== 8. 商品描述两行 =====
console.log("\n--- 8. 商品描述 ---");
{
  const desc = rule(".v02-description");
  chkTrue("限制两行", /-webkit-line-clamp:2/.test(desc));
  chkTrue("超出用省略号（不是硬裁一半的字）", /overflow:hidden/.test(desc) && /-webkit-box-orient:vertical/.test(desc));
  // 🔴 2026-09-25 抓到的真 bug：文件里曾有第二条 .v02-description{display:block;…} 排在后面，
  //    同权重后写的赢 → display 变回 block → -webkit-line-clamp 直接被忽略，两行限制成了空闸。
  //    当前文案都不到两行，肉眼看不出来，只能靠这两条断言守住。
  const ruleCount = (source.match(/\.v02-description\s*\{/g) || []).length;
  chk("全文件只有一条 .v02-description 规则（多一条就可能把它覆盖掉）", ruleCount, 1);
  chkTrue("display 必须是 -webkit-box（写 block 则 line-clamp 失效）", /display:-webkit-box/.test(desc));
  chkTrue("没有把它覆盖回 block 的写法（注释里提到不算）", !/\.v02-description[^{]*\{[^}]*display:block/.test(codeOnly));
}

// ===== 9. 图标按钮的 tooltip / aria-label =====
console.log("\n--- 9. 图标按钮可识别 ---");
{
  const closeButtons = [...source.matchAll(/<button[^>]*class="v02-close"[^>]*>/g)].map(m => m[0]);
  chk("三处抽屉/商店关闭按钮都取到了", closeButtons.length, 3);
  chkTrue("每个关闭按钮都有 aria-label", closeButtons.every(tag => /aria-label="[^"]+"/.test(tag)));
  chkTrue("每个关闭按钮都有 title（鼠标悬停的 tooltip）", closeButtons.every(tag => /title="[^"]+"/.test(tag)));
  chkTrue("配置提示的关闭按钮也补齐了 title",
    /class="config-notice-close" id="configNoticeClose" aria-label="关闭提示" title="关闭提示"/.test(source));
  chkTrue("静音按钮有 title", /id="audioToggle" aria-label="静音" title="静音 \/ 取消静音"/.test(source));
  chkTrue("音频设置按钮有 title", /id="audioSettingsToggle" aria-label="音频设置" title="音频设置"/.test(source));
  // 商品名来自后台配置，插进 HTML（含属性）前必须转义 —— 所以这里是 escapeHtml(item.name)，
  // 断言同时锁住两件事：按钮有可识别的名字 + 名字是转义过的（不能直接插 ${item.name}）。
  const minusBtnRe = /data-minus="\$\{item\.id\}" aria-label="减少一条\$\{escapeHtml\(item\.name\)\}" title="减少一条"/;
  const plusBtnRe = /data-plus="\$\{item\.id\}" aria-label="增加一条\$\{escapeHtml\(item\.name\)\}" title="增加一条"/;
  chkTrue("商店加减数量按钮有名字（否则读屏只念「加号」）", minusBtnRe.test(source) && plusBtnRe.test(source));
  chkTrue("按钮名字里的商品名是转义过的（后台配置不能直接插进属性）",
    minusBtnRe.test(source) && plusBtnRe.test(source)
    && !/aria-label="(?:减少|增加)一条\$\{item\.name\}"/.test(source));
  chkTrue("商店卡片正文的商品名 / 描述也是转义过的",
    /class="v02-item-name-text">\$\{escapeHtml\(item\.name\)\}</.test(source)
    && /class="v02-description">\$\{escapeHtml\(item\.description\|\|""\)\}</.test(source));
  chkTrue("结算小票里的商品名也是转义过的", /\$\{escapeHtml\(row\.name\)\}/.test(source));
  chkTrue("时长 −/+ 按钮本来就有（回归确认没被覆盖掉）",
    /id="timeMinus" aria-label="减少专注时长" title="减少 5 分钟"/.test(source)
    && /id="timePlus" aria-label="增加专注时长" title="增加 5 分钟"/.test(source));
}

// ===== 10. 背景图尺寸标准 =====
console.log("\n--- 10. 背景图尺寸标准 ---");
{
  chkTrue("后台上传提示写了尺寸/格式/体积标准",
    /背景图请压到 1600×900（16:9）、JPG 或 WebP、单张 ≤400KB/.test(adminSource));
  chkTrue("并说明超标的后果（拖慢首屏）", /超过这个量级会明显拖慢首屏加载/.test(adminSource));
}

// ===== 11. 响应式覆盖必须排在基础规则之后 =====
// 🔴 2026-09-25 抓到的真 bug：媒体查询不增加选择器权重，同权重后写的赢。
//    这两个 @media 块原来排在 .v02-topbar / .v02-top-entry / .v02-bubbles 的基础规则前面，
//    里面的覆盖全是死代码 —— 360px 实测顶栏 padding 仍是 10px 16px、字号仍是 13px，
//    横屏顶栏高度仍是 52px 而不是 42px。真浏览器验收才看出来，单测只能靠位置断言守。
console.log("\n--- 11. 响应式覆盖的书写位置 ---");
{
  const styleEnd = source.lastIndexOf("</style>");
  // 注意 .timer 的基础规则写成 ".timer {"（带空格），不能用 ".timer{" 去找 —— 那样会命中
  // 断点里那条紧凑写法，位置断言就永远假失败。
  const baseRules = [".v02-topbar{", ".v02-top-entry{", ".v02-bubbles{", ".timer {", ".v02-focus{"];
  const mediaIdx = source.indexOf("@media (max-width:520px)");
  const landIdx = source.indexOf("@media (orientation: landscape)");
  chkTrue("小屏断点存在", mediaIdx > 0);
  chkTrue("横屏断点存在", landIdx > 0);
  chkTrue("小屏断点排在它要覆盖的基础规则之后",
    baseRules.every(sel => source.indexOf(sel) < mediaIdx),
    JSON.stringify(baseRules.map(sel => `${sel}:${source.indexOf(sel)}`)));
  chkTrue("横屏断点也排在基础规则之后",
    baseRules.every(sel => source.indexOf(sel) < landIdx));
  chkTrue("两个断点都还在 <style> 里", mediaIdx < styleEnd && landIdx < styleEnd);
  // 反向：断点里确实写了顶栏压缩（不是空的）
  const small = source.slice(mediaIdx, source.indexOf("}", source.indexOf(".v02-top-entry{padding:5px 9px", mediaIdx)) + 1);
  chkTrue("小屏断点真的收紧了顶栏内边距", /\.v02-topbar\{padding:8px 10px/.test(small));
  chkTrue("小屏断点真的收紧了入口按钮", /\.v02-top-entry\{padding:5px 9px;font-size:12px\}/.test(small));
  // 泡泡数在 ≤480px 曾被 display:none 藏掉（搬进顶栏后手机上就完全看不见泡泡了）。
  chkTrue("小屏不再把泡泡数藏起来", !/@media\(max-width:480px\)\{\.v02-bubbles\{display:none\}/.test(source));
  chkTrue("泡泡数锁死不换行（窄屏下「🫧 3000」会在 emoji 后断行，把顶栏撑成两行）",
    /\.v02-bubbles\{[^}]*white-space:nowrap/.test(compact));
}

console.log("----");
console.log(`player-tank-ui.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);