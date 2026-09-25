// 同步码保存引导弹窗的回归测试（index.html）。
//
// 对应 V1.0 定稿 R6：同步码是唯一的跨设备凭证、丢了找不回，所以建号后要
// 用一次显眼弹窗引导用户「换设备时用同步码接管」，只弹一次。
//
// 沿用项目约定：从 index.html 抽真实源码到沙箱里跑，不手抄实现。
//   · 静态锚点锁结构：元素存在、两个分支都接了弹窗、go 按钮会生成码并开面板。
//   · 运行时锁行为：flag 已存在就不弹、go 触发生成+开面板+写 flag、skip 只写 flag。
//   · 反向验证：去掉 flag 闸门会向「已看过」的用户也弹，确认断言会红。
//
// 运行：node test/sync-guide.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const source = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}
function chkTrue(name, actual, detail = "") {
  const ok = actual === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}

const norm = text => text.replace(/\r\n/g, "\n");
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === ch) { j += 1; break; }
        if (text[j] === "\n" && ch !== "`") break;
        j += 1;
      }
      if (j > i + 1 && text[j - 1] === ch) { out += text.slice(i, j); i = j; continue; }
      out += ch; i += 1; continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop; continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop; continue;
    }
    out += ch; i += 1;
  }
  return out;
}
const playerRaw = norm(source);
const playerCode = stripComments(playerRaw);

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  const isAsync = src.slice(Math.max(0, start - 6), start) === "async ";
  const begin = isAsync ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(begin, i + 1); }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

// ============================================================
console.log("--- 1. 静态结构：弹窗元素 + 函数都在 ---");
// ============================================================
chkTrue("HTML 有引导弹窗 #syncGuide", /id="syncGuide"/.test(playerRaw));
chkTrue("弹窗有标题", /id="syncGuideTitle"/.test(playerRaw));
chkTrue("弹窗有「去生成同步码」按钮 #syncGuideGo", /id="syncGuideGo"/.test(playerRaw));
chkTrue("弹窗有「以后再说」按钮 #syncGuideSkip", /id="syncGuideSkip"/.test(playerRaw));
chkTrue("弹窗默认隐藏（hidden）", /id="syncGuide"[^>]*\shidden/.test(playerRaw));
chkTrue("maybeShowSyncGuide 函数存在", /function maybeShowSyncGuide\(\)/.test(playerCode));
chkTrue("syncGuideGo 函数存在", /function syncGuideGo\(\)/.test(playerCode));
chkTrue("syncGuideSkip 函数存在", /function syncGuideSkip\(\)/.test(playerCode));

const ensureSrc = extractFunction(playerCode, "ensureAccount");
chkTrue("ensureAccount 接了引导弹窗（建号/有令牌两分支都会调）", /maybeShowSyncGuide\(\);/.test(ensureSrc));
const goSrc = extractFunction(playerCode, "syncGuideGo");
chkTrue("go 按钮会生成同步码", /generateSyncCode\(\)/.test(goSrc));
chkTrue("go 按钮会打开「我的」抽屉", /openDrawer\("mineDrawer"\)/.test(goSrc));
chkTrue("go 按钮会写「已看过」标记", /localStorage\.setItem\(SYNC_GUIDE_KEY/.test(goSrc));
chkTrue("skip 也会写「已看过」标记", /localStorage\.setItem\(SYNC_GUIDE_KEY/.test(extractFunction(playerCode, "syncGuideSkip")));
chkTrue("弹窗文案说清「换设备时现生成、不用提前存」", /现生成|10 分钟/.test(playerRaw));

// ============================================================
console.log("\n--- 2. 运行时：flag 闸门 + go/skip 行为 ---");
// ============================================================

// 2.1 账号就绪 + 没看过 → 弹
{
  const code = [
    'const SYNC_GUIDE_KEY = "fishtank_sync_guide_v1";',
    "let CLOUD_SYNC_ENABLED = true;",
    'let ACCOUNT_TOKEN = "tok";',
    "let genCount = 0;",
    "const localStorage = { _d:{}, getItem(k){ return k in this._d ? this._d[k] : null; }, setItem(k,v){ this._d[k]=String(v); } };",
    "const __els = { syncGuide: { hidden: true }, mineDrawer: { classList: (()=>{ const s=new Set(); return { add:c=>s.add(c), remove:c=>s.delete(c), contains:c=>s.has(c) }; })(), setAttribute(){} } };",
    "const document = { getElementById: id => __els[id] || null };",
    "function generateSyncCode(){ genCount++; return Promise.resolve(); }",
    "function openDrawer(id){ const el = __els[id]; if(el){ el.classList.add('show'); el.setAttribute('aria-hidden','false'); } }",
    "function renderMineStats(){}",
    extractFunction(playerCode, "maybeShowSyncGuide"),
    extractFunction(playerCode, "syncGuideGo"),
    extractFunction(playerCode, "syncGuideSkip"),
    "return { maybeShowSyncGuide, syncGuideGo, syncGuideSkip, syncGuide: __els.syncGuide, drawer: __els.mineDrawer, getFlag: () => localStorage.getItem(SYNC_GUIDE_KEY), genCount: () => genCount };"
  ].join("\n");
  const box = new Function(code)();
  box.maybeShowSyncGuide();
  chk("账号就绪且没看过 → 弹窗显示", box.syncGuide.hidden, false);
}

// 2.2 已看过（flag 存在）→ 不弹
{
  // 预置一个已看过（flag 已写入 localStorage）的环境：把 localStorage 初始 _d 塞进 flag。
  const code = [
    'const SYNC_GUIDE_KEY = "fishtank_sync_guide_v1";',
    "let CLOUD_SYNC_ENABLED = true;",
    'let ACCOUNT_TOKEN = "tok";',
    "let genCount = 0;",
    'const localStorage = { _d:{"fishtank_sync_guide_v1":"1"}, getItem(k){ return k in this._d ? this._d[k] : null; }, setItem(k,v){ this._d[k]=String(v); } };',
    "const __els = { syncGuide: { hidden: true }, mineDrawer: { classList: (()=>{ const s=new Set(); return { add:c=>s.add(c), remove:c=>s.delete(c), contains:c=>s.has(c) }; })(), setAttribute(){} } };",
    "const document = { getElementById: id => __els[id] || null };",
    "function generateSyncCode(){ genCount++; return Promise.resolve(); }",
    "function openDrawer(id){ const el = __els[id]; if(el){ el.classList.add('show'); el.setAttribute('aria-hidden','false'); } }",
    "function renderMineStats(){}",
    extractFunction(playerCode, "maybeShowSyncGuide"),
    extractFunction(playerCode, "syncGuideGo"),
    extractFunction(playerCode, "syncGuideSkip"),
    "return { maybeShowSyncGuide, syncGuideGo, syncGuideSkip, syncGuide: __els.syncGuide, drawer: __els.mineDrawer, getFlag: () => localStorage.getItem(SYNC_GUIDE_KEY), genCount: () => genCount };"
  ].join("\n");
  const box2 = new Function(code)();
  box2.maybeShowSyncGuide();
  chk("已看过（flag 存在）→ 弹窗保持隐藏", box2.syncGuide.hidden, true);
}

// 2.3 go：隐藏弹窗 + 写 flag + 打开面板 + 生成码
{
  const code = [
    'const SYNC_GUIDE_KEY = "fishtank_sync_guide_v1";',
    "let CLOUD_SYNC_ENABLED = true;",
    'let ACCOUNT_TOKEN = "tok";',
    "let genCount = 0;",
    "const localStorage = { _d:{}, getItem(k){ return k in this._d ? this._d[k] : null; }, setItem(k,v){ this._d[k]=String(v); } };",
    "const __els = { syncGuide: { hidden: true }, mineDrawer: { classList: (()=>{ const s=new Set(); return { add:c=>s.add(c), remove:c=>s.delete(c), contains:c=>s.has(c) }; })(), setAttribute(){} } };",
    "const document = { getElementById: id => __els[id] || null };",
    "function generateSyncCode(){ genCount++; return Promise.resolve(); }",
    "function openDrawer(id){ const el = __els[id]; if(el){ el.classList.add('show'); el.setAttribute('aria-hidden','false'); } }",
    "function renderMineStats(){}",
    extractFunction(playerCode, "maybeShowSyncGuide"),
    extractFunction(playerCode, "syncGuideGo"),
    extractFunction(playerCode, "syncGuideSkip"),
    "return { maybeShowSyncGuide, syncGuideGo, syncGuideSkip, syncGuide: __els.syncGuide, drawer: __els.mineDrawer, getFlag: () => localStorage.getItem(SYNC_GUIDE_KEY), genCount: () => genCount };"
  ].join("\n");
  const box = new Function(code)();
  box.syncGuide.hidden = false; // 先弹出来
  box.syncGuideGo();
  chk("go 后弹窗隐藏", box.syncGuide.hidden, true);
  chk("go 后写入已看过标记", box.getFlag(), "1");
  chkTrue("go 后打开「我的」抽屉（classList 含 show）", box.drawer.classList.contains("show"));
  chk("go 后触发了一次同步码生成", box.genCount(), 1);
}

// 2.4 skip：隐藏 + 写 flag，不生成码
{
  const code = [
    'const SYNC_GUIDE_KEY = "fishtank_sync_guide_v1";',
    "let CLOUD_SYNC_ENABLED = true;",
    'let ACCOUNT_TOKEN = "tok";',
    "let genCount = 0;",
    "const localStorage = { _d:{}, getItem(k){ return k in this._d ? this._d[k] : null; }, setItem(k,v){ this._d[k]=String(v); } };",
    "const __els = { syncGuide: { hidden: true }, mineDrawer: { classList: (()=>{ const s=new Set(); return { add:c=>s.add(c), remove:c=>s.delete(c), contains:c=>s.has(c) }; })(), setAttribute(){} } };",
    "const document = { getElementById: id => __els[id] || null };",
    "function generateSyncCode(){ genCount++; return Promise.resolve(); }",
    "function openDrawer(id){ const el = __els[id]; if(el){ el.classList.add('show'); el.setAttribute('aria-hidden','false'); } }",
    "function renderMineStats(){}",
    extractFunction(playerCode, "maybeShowSyncGuide"),
    extractFunction(playerCode, "syncGuideGo"),
    extractFunction(playerCode, "syncGuideSkip"),
    "return { maybeShowSyncGuide, syncGuideGo, syncGuideSkip, syncGuide: __els.syncGuide, drawer: __els.mineDrawer, getFlag: () => localStorage.getItem(SYNC_GUIDE_KEY), genCount: () => genCount };"
  ].join("\n");
  const box = new Function(code)();
  box.syncGuide.hidden = false;
  box.syncGuideSkip();
  chk("skip 后弹窗隐藏", box.syncGuide.hidden, true);
  chk("skip 后写入已看过标记", box.getFlag(), "1");
  chk("skip 不触发同步码生成", box.genCount(), 0);
}

// ============================================================
console.log("\n--- 3. 反向验证：去掉 flag 闸门会向已看过的用户也弹 ---");
// ============================================================
{
  const header = [
    'const SYNC_GUIDE_KEY = "fishtank_sync_guide_v1";',
    "let CLOUD_SYNC_ENABLED = true;",
    'let ACCOUNT_TOKEN = "tok";',
    "let genCount = 0;",
    'const localStorage = { _d:{"fishtank_sync_guide_v1":"1"}, getItem(k){ return k in this._d ? this._d[k] : null; }, setItem(k,v){ this._d[k]=String(v); } };',
    "const __els = { syncGuide: { hidden: true }, mineDrawer: { classList: (()=>{ const s=new Set(); return { add:c=>s.add(c), remove:c=>s.delete(c), contains:c=>s.has(c) }; })(), setAttribute(){} } };",
    "const document = { getElementById: id => __els[id] || null };",
    "function generateSyncCode(){ genCount++; return Promise.resolve(); }"
  ].join("\n");

  const realSrc = extractFunction(playerCode, "maybeShowSyncGuide");
  // broken：把「已看过就 return」的闸门删掉
  const brokenSrc = realSrc.replace(/if\(seen\)\s*return;\s*/, "");

  const real = new Function(header + "\n" + realSrc + "\nreturn { maybeShowSyncGuide, syncGuide: __els.syncGuide };")();
  real.maybeShowSyncGuide();
  const realHidden = real.syncGuide.hidden;

  const broken = new Function(header + "\n" + brokenSrc + "\nreturn { maybeShowSyncGuide, syncGuide: __els.syncGuide };")();
  broken.maybeShowSyncGuide();
  const brokenHidden = broken.syncGuide.hidden;

  chkTrue("正向：闸门在，已看过用户不弹（hidden=true）", realHidden === true);
  chkTrue("反向：删掉闸门后，已看过用户也会弹（hidden=false），证明这道闸真的起作用", brokenHidden === false);
}

console.log(`\n===== 同步码引导弹窗测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
