// F3 回归测试：后台上传的动画代码在玩家端的执行边界。
//
// 重点验证：
//   1. compileFishAnimation 对空/语法错误返回 null（回退内置），对合法代码返回可调用函数。
//   2. 常见全局名被参数遮蔽（window/document/fetch/localStorage/globalThis…）→ 代码里拿到 undefined。
//   3. 严格模式生效：给未声明变量赋值会抛错（而不是悄悄创建全局变量）。
//   4. makeFishApi 只暴露受控 API，不泄漏 DOM/全局。
//   5. runFishAnimation 出错只停用这一条鱼的动画（不会拖垮鱼缸）。
//
// 说明：这是**稳定性**边界，不是安全沙箱 —— new Function 仍可能通过 this/constructor 链绕过。
// 沿用项目约定：按函数名从 index.html 抽取真实源码到沙箱里跑。
// 运行：node test/fish-animation.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

// FISH_ANIM_SHADOWED 是 const 数组，不是函数，单独从源码里取出来。
const shadowedSrc = (source.match(/const FISH_ANIM_SHADOWED = \[[^\]]*\];/) || [""])[0];
if (!shadowedSrc) throw new Error("index.html 里找不到 FISH_ANIM_SHADOWED");

const { compileFishAnimation, makeFishApi, runFishAnimation } = new Function(`
${shadowedSrc}
${extractFunction(source, "compileFishAnimation")}
${extractFunction(source, "makeFishApi")}
${extractFunction(source, "runFishAnimation")}
return { compileFishAnimation, makeFishApi, runFishAnimation };`)();

console.log("--- 编译 ---");
chk("空代码 → null（回退内置）", compileFishAnimation(""), null);
chk("纯空白 → null", compileFishAnimation("   \n  "), null);
chk("undefined → null", compileFishAnimation(undefined), null);
chk("合法代码 → 函数", typeof compileFishAnimation("fish.speed = 3;"), "function");
chk("语法错误 → null", compileFishAnimation("this is not js {{{"), null);

console.log("\n--- 全局名被遮蔽（代码里拿不到 window/document/fetch/localStorage/globalThis）---");
const globals = ["window", "document", "fetch", "localStorage", "globalThis", "XMLHttpRequest", "navigator", "Function"];
globals.forEach(name => {
  const fn = compileFishAnimation(`return typeof ${name};`);
  chk(`typeof ${name}`, fn ? fn({}) : "编译失败", "undefined");
});

console.log("\n--- 严格模式：给未声明变量赋值应抛错 ---");
const strictFn = compileFishAnimation("accidental = 1; return accidental;");
let strictThrew = false;
try { strictFn({}); } catch (_) { strictThrew = true; }
chk("未声明赋值抛错（严格模式生效）", strictThrew, true);

console.log("\n--- 受控 API ---");
const fakeImg = { naturalWidth: 64, naturalHeight: 48, style: {} };
const api = makeFishApi({ partEls: { body: fakeImg }, x: 1, y: 2, facingLeft: true, scale: 1, speed: 2, burstSpeed: 0, radius: 20 }, 1.5);
chk("parts 尺寸取自图片", api.parts.body, { w: 64, h: 48 });
chk("t 透传", api.t, 1.5);
chk("不暴露 window", "window" in api, false);
chk("不暴露 document", "document" in api, false);
chk("不暴露 fetch", "fetch" in api, false);
chk("不暴露 localStorage", "localStorage" in api, false);
chk("有 setPart", typeof api.setPart, "function");
chk("有 rand/randRange", typeof api.rand === "function" && typeof api.randRange === "function", true);
chk("setPart 写 transform", (api.setPart("body", { rotate: 30 }), fakeImg.style.transform), "translate(0px, 0px) rotate(30deg) scale(1, 1)");
chk("opacity 被夹到 [0,1]", (api.setPart("body", { opacity: 2 }), fakeImg.style.opacity), "1");
chk("未知插槽 setPart 返回 false", api.setPart("nope", {}), false);

console.log("\n--- 逐帧执行与错误边界 ---");
const okState = { animation: compileFishAnimation("fish.speed = 9;"), speed: 2, burstSpeed: 0, partEls: null, x: 0, y: 0, facingLeft: true, scale: 1, radius: 10 };
chk("正常运行返回 true", runFishAnimation(okState, 1), true);
chk("speed 被写回 state", okState.speed, 9);

const badState = { animation: compileFishAnimation("throw new Error('boom');"), speed: 2, burstSpeed: 0, partEls: null };
chk("运行出错返回 false", runFishAnimation(badState, 1), false);
chk("出错后停用该鱼动画（animation=null）", badState.animation, null);
chk("再次调用不再执行（返回 false）", runFishAnimation(badState, 2), false);

chk("没有动画时返回 false", runFishAnimation({ animation: null }, 1), false);

console.log("\n----");
console.log(`fish-animation.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
