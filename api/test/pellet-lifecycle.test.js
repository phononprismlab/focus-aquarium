// 饲料生命周期（dominik 2026-10-07 反馈）。
//
// 锁三件事：
//   1) 每粒饲料有自己的出生时间，3 分钟没被吃掉就自己消失（走和「被吃掉」同一条淡出 + 移除）；
//   2) 结束专注（毛玻璃重新盖回来）时清空缸里所有饲料；
//   3) 为了让 resetFocus 能安全清空，`pellets` 的声明必须排在 resetFocus 之前 ——
//      页面加载末尾的 restoreFocusSession() 可能直接走到补结算 → 调 resetFocus，
//      那时 `let` 还没执行会踩 TDZ。这是本轮改动里唯一一处「顺序错了就整页崩」的地方。
//
// 反向验证：把 PELLET_TTL_MS 那段判过期删掉 → 第 1 节 3 条红；
//          把 clearPellets() 从 resetFocus 删掉 → 第 2 节 1 条红；
//          把 `let pellets = []` 挪回 SAND_RATIO 附近（resetFocus 之后）→ 第 3 节红。
//
// 运行：node api/test/pellet-lifecycle.test.js   （或归入 run-unit.mjs 从仓库根跑）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..", "..");
const source = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8").replace(/\r\n/g, "\n");

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
// 按大括号配对抽出整个函数体（index.html 里的函数都在同一个 IIFE 里，逐层数括号最稳）。
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

console.log("--- 1. 过期时间：3 分钟没被吃掉就消失 ---");
{
  chkTrue("有 3 分钟的饲料存活上限（单一常量）",
    /const PELLET_TTL_MS = 3 \* 60 \* 1000;/.test(source));
  chkTrue("落饲料时记下出生时间",
    /pellets\.push\(\{[^}]*bornAt: performance\.now\(\)/.test(source));

  const animate = extractFunction(source, "animate");
  chkTrue("animate 里按出生时间判过期（不是靠 Math.random）",
    /pelletNow - p\.bornAt >= PELLET_TTL_MS/.test(animate));
  chkTrue("到点标记 eaten 并加 .eaten 类（复用被吃掉那条淡出）",
    /p\.eaten = true;\s*p\.el\.classList\.add\("eaten"\);/.test(animate));
  chkTrue("元素延迟 150ms 移除（等淡出动画放完，和吃食一致）",
    /setTimeout\(\(\) => expired\.remove\(\), 150\)/.test(animate));
  chkTrue("过期的那粒不会在同一帧又被当成下落中的饲料",
    /if \(!p\.eaten && pelletNow - p\.bornAt >= PELLET_TTL_MS\)[\s\S]{0,240}return;/.test(animate));
}

console.log("\n--- 2. 结束专注：清空缸里所有饲料 ---");
{
  const clear = extractFunction(source, "clearPellets");
  chkTrue("clearPellets 把元素从 DOM 摘掉（不是只清数组）",
    /p\.el\.parentNode\) p\.el\.remove\(\)/.test(clear));
  chkTrue("clearPellets 把数组清空", /pellets = \[\];/.test(clear));

  const reset = extractFunction(source, "resetFocus");
  chkTrue("resetFocus 调 clearPellets（就在毛玻璃盖回来的那一处）",
    /syncFocusRunningClass\(\);[\s\S]{0,160}clearPellets\(\);/.test(reset));
}

console.log("\n--- 3. 声明顺序：pellets 必须在 resetFocus 之前（TDZ 闸门）---");
{
  const decl = source.indexOf("let pellets = [];");
  const resetFn = source.indexOf("function resetFocus(");
  const restore = source.indexOf("restoreFocusSession();");
  chk("pellets 只声明一次", source.split("let pellets = [];").length - 1, 1);
  chkTrue("声明在 resetFocus 之前", decl > 0 && decl < resetFn, `decl=${decl} resetFocus=${resetFn}`);
  chkTrue("声明在 restoreFocusSession() 调用之前", decl > 0 && decl < restore, `decl=${decl} restore=${restore}`);
  // 反向：clearPellets 必须在声明之后（否则它自己就够不着 pellets）。
  const clearFn = source.indexOf("function clearPellets(");
  chkTrue("clearPellets 定义在 pellets 声明之后", clearFn > decl, `clear=${clearFn} decl=${decl}`);
}

console.log(`\n==== pellet-lifecycle: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
