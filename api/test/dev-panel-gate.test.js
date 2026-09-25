// DEV 面板必须只在 ?dev=1 时出现。
//
// 为什么这是硬要求：面板里有「+10000 泡泡」「切换会员」，而泡泡是**客户端权威**
// （player-store.js 的注释自承），这两下都会真实推进云存档 ——
// 线上任何玩家点开就能给自己刷泡泡、开会员。
//
// 两道闸：① CSS 默认隐藏按钮；② 处理器本身也过 devOnly()，
// 免得玩家在控制台里 document.getElementById("devAdd10000").click()。
// 运行：node test/dev-panel-gate.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`PASS | ${name} = ${JSON.stringify(actual)}`);
    pass++;
  } else {
    console.log(`FAIL | ${name} 期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
    fail++;
  }
}
function chkTrue(name, condition) {
  if (condition) { console.log(`PASS | ${name}`); pass++; }
  else { console.log(`FAIL | ${name}`); fail++; }
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
function extractConst(src, name) {
  const match = src.match(new RegExp(`const ${name} = [^\\n]*;`));
  if (!match) throw new Error(`index.html 里找不到常量 ${name}`);
  return match[0];
}

console.log("--- 1. 开关判定：只有 ?dev=1 算开 ---");
{
  const factory = new Function(`${extractFunction(source, "devModeEnabled")}\nreturn devModeEnabled;`);
  const on = factory();
  chk("?dev=1 → 开", on("?dev=1"), true);
  chk("?dev=1&x=2 → 开（组合参数不误伤）", on("?dev=1&x=2"), true);
  chk("空 query → 关", on(""), false);
  chk("?dev=0 → 关", on("?dev=0"), false);
  chk("?dev=true → 关（只认 \"1\"）", on("?dev=true"), false);
  chk("?dev → 关（没有值）", on("?dev"), false);
  chk("?other=1 → 关", on("?other=1"), false);
}

console.log("\n--- 2. devOnly：关闸时处理器不执行 ---");
{
  const factory = new Function("DEV_ENABLED", `${extractConst(source, "devOnly")}\nreturn devOnly;`);
  let hits = 0;
  const off = factory(false);
  const on = factory(true);
  off(() => { hits++; })("a", "b");
  chk("DEV_ENABLED=false 时内层一次都没跑", hits, 0);
  on(() => { hits++; })("a", "b");
  chk("DEV_ENABLED=true 时才放行", hits, 1);
  // 反向：如果 devOnly 退化成直接返回 fn，上面第一条就会是 1 → 断言变红。
  chkTrue("devOnly 确实读了 DEV_ENABLED（不是恒等包装）",
    /if\s*\(\s*DEV_ENABLED\s*\)\s*fn\(/.test(source));
}

console.log("\n--- 3. 静态锚：按钮默认隐藏，且只认 body.dev-on ---");
{
  const toggleRule = source.match(/\.dev-toggle\{[^}]*\}/);
  chkTrue("找得到 .dev-toggle 规则", Boolean(toggleRule));
  chkTrue(".dev-toggle 默认 display:none", /display\s*:\s*none/.test(toggleRule[0]));
  chkTrue("body.dev-on 才显示按钮",
    /body\.dev-on\s+\.dev-toggle\s*\{\s*display\s*:\s*block\s*\}/.test(source));
  chkTrue("非 dev-on 下面板被硬关掉",
    /body:not\(\.dev-on\)\s+\.dev-panel\s*\{\s*display\s*:\s*none\s*!important\s*\}/.test(source));
  chkTrue("面板的 .show 也要在 dev-on 之下才生效",
    /body\.dev-on\s+\.dev-panel\.show\s*\{\s*display\s*:\s*block\s*\}/.test(source));
}

console.log("\n--- 4. 静态锚：body 挂 dev-on 必须由开关驱动，且处理器全部过闸 ---");
{
  chkTrue("dev-on 是条件挂上的，不是写死在 HTML 里",
    /if\s*\(\s*DEV_ENABLED\s*\)\s*document\.body\.classList\.add\("dev-on"\)/.test(source));
  chkTrue("<body> 标签本身没有 dev-on 类",
    !/<body[^>]*class="[^"]*dev-on/.test(source));

  // 10 个 DEV 按钮的处理器都必须包一层 devOnly —— 少一个就是一条后门。
  const handlers = source.match(/getElementById\("dev[A-Za-z0-9]+"\)\.addEventListener\(\s*"click"\s*,\s*devOnly\(/g) || [];
  chk("10 个 DEV 处理器全部过 devOnly", handlers.length, 10);

  const devButtons = source.match(/getElementById\("dev[A-Za-z0-9]+"\)\.addEventListener\(\s*"click"/g) || [];
  chk("DEV 处理器总数与过闸数一致", devButtons.length, handlers.length);
}

console.log(`\n===== DEV 面板开关测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
