// F2 / F5 回归测试：鱼类资源装配格式解析 + feedReaction 投喂开关。
//
// F2：鱼的 resourcePath 有两种形态 —— 旧格式（单字符串，走 CSS 鱼）与
//     新格式（[{slot,path}]，按插槽用后台上传的图片拼装）。fishPartsFromAssembly 负责判别。
// F5：只有 feedReaction !== false 的鱼才追饲料。
//
// 沿用项目约定：按函数名从 index.html 抽取真实源码到沙箱里跑，不手抄实现。
// 运行：node test/fish-assembly.test.js
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

const { fishPartsFromAssembly, fishReactsToFeed } = new Function(`
${extractFunction(source, "fishPartsFromAssembly")}
${extractFunction(source, "fishReactsToFeed")}
return { fishPartsFromAssembly, fishReactsToFeed };`)();

console.log("--- F2：resourcePath 格式解析 ---");
chk("旧字符串资源 → null（回退 CSS 鱼）", fishPartsFromAssembly({ resourcePath: "assets/fish/clownfish.png" }), null);
chk("没有 resourcePath → null", fishPartsFromAssembly({}), null);
chk("assembly 为 null → null", fishPartsFromAssembly(null), null);
chk("空数组 → null", fishPartsFromAssembly({ resourcePath: [] }), null);
chk("新格式数组 → slot 映射", fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "a.png" }, { slot: "tail", path: "b.png" }] }), { body: "a.png", tail: "b.png" });
chk("纯字符串数组 → 归到 body", fishPartsFromAssembly({ resourcePath: ["a.png"] }), { body: "a.png" });
chk("过滤掉没有 path 的项", fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "a.png" }, { slot: "tail", path: "" }] }), { body: "a.png" });
chk("过滤掉没有 slot 的项", fishPartsFromAssembly({ resourcePath: [{ slot: "", path: "a.png" }] }), null);

console.log("\n--- F5：feedReaction 投喂开关 ---");
chk("未设置 feedReaction → 默认会吃", fishReactsToFeed({}), true);
chk("feedReaction:true → 会吃", fishReactsToFeed({ feedReaction: true }), true);
chk("feedReaction:false → 不吃", fishReactsToFeed({ feedReaction: false }), false);
chk("fish 为 null → 不崩（会吃）", fishReactsToFeed(null), true);

console.log("\n----");
console.log(`fish-assembly.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
