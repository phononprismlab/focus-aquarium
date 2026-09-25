// F2 / F5 回归测试：鱼类资源装配格式解析 + feedReaction 投喂开关。
//
// F2：鱼的 resourcePath 有两种形态 —— 旧格式（单字符串，走 CSS 鱼）与
//     新格式（[{slot,path}]，按插槽用后台上传的图片拼装）。fishPartsFromAssembly 负责判别。
//
//     🔴 2026-09-25 修：判别必须带 IMAGE_SOURCE_RE（只认后台上传回来的绝对图片地址）。
//        种子鱼的 resourcePath 是相对路径（assets/fish/blue-tang.png），后台把「对投喂产生
//        反应」关掉再保存时会把它规整成 [{slot:"body",path:"assets/fish/…"}]，于是玩家端
//        渲染出一个 404 的 <img> → 蓝尾鱼直接消失。旧格式字符串同样要挡。
//
// F5：只有 feedReaction !== false 的鱼才追饲料。
//
// 沿用项目约定：按函数名从 index.html 抽取真实源码到沙箱里跑，不手抄实现。
// 运行：node test/fish-assembly.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}
function chkTrue(name, condition) {
  if (condition) { console.log(`PASS | ${name}`); pass += 1; }
  else { console.log(`FAIL | ${name}`); fail += 1; }
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

// 从 index.html 抓真实的正则字面量，避免测试里手抄一份、日后改了实现测试还是绿的。
const imageSourceReLiteral = (source.match(/const IMAGE_SOURCE_RE = (\/[^\n]*\/i);/) || [])[1];
if (!imageSourceReLiteral) throw new Error("index.html 里找不到 IMAGE_SOURCE_RE 的字面量声明");

const { fishPartsFromAssembly, fishReactsToFeed, IMAGE_SOURCE_RE } = new Function(`
const IMAGE_SOURCE_RE = ${imageSourceReLiteral};
${extractFunction(source, "fishPartsFromAssembly")}
${extractFunction(source, "fishReactsToFeed")}
return { fishPartsFromAssembly, fishReactsToFeed, IMAGE_SOURCE_RE };`)();

const CDN = "https://cdn.example.com/fish";

console.log("--- F2：resourcePath 格式解析 ---");
chk("旧字符串资源（相对路径）→ null（回退 CSS 鱼）", fishPartsFromAssembly({ resourcePath: "assets/fish/clownfish.png" }), null);
chk("旧字符串资源（绝对地址）→ 仍归 null（旧格式一律走 CSS 鱼，不按图拼）", fishPartsFromAssembly({ resourcePath: `${CDN}/clownfish.png` }), null);
chk("没有 resourcePath → null", fishPartsFromAssembly({}), null);
chk("assembly 为 null → null", fishPartsFromAssembly(null), null);
chk("空数组 → null", fishPartsFromAssembly({ resourcePath: [] }), null);
chk("新格式数组 → slot 映射",
  fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: `${CDN}/a.png` }, { slot: "tail", path: `${CDN}/b.png` }] }),
  { body: `${CDN}/a.png`, tail: `${CDN}/b.png` });
chk("纯字符串数组 → 归到 body", fishPartsFromAssembly({ resourcePath: [`${CDN}/a.png`] }), { body: `${CDN}/a.png` });
chk("过滤掉没有 path 的项",
  fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: `${CDN}/a.png` }, { slot: "tail", path: "" }] }),
  { body: `${CDN}/a.png` });
chk("过滤掉没有 slot 的项", fishPartsFromAssembly({ resourcePath: [{ slot: "", path: `${CDN}/a.png` }] }), null);
chk("过滤掉非图片扩展名（.txt 不是图）", fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: `${CDN}/a.txt` }] }), null);

console.log("\n--- F2b：蓝尾鱼 bug 回归（旧相对路径不能被当成图片插槽）---");
chk("新格式里的相对路径 → 被过滤，整条走 CSS 鱼",
  fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "assets/fish/blue-tang.png" }] }), null);
chk("相对路径的多种写法都挡掉（无前导、./、../）",
  [
    fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "fish/x.png" }] }),
    fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "./assets/x.png" }] }),
    fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "../x.png" }] })
  ], [null, null, null]);
chk("坏路径 + 好路径混合 → 只留可用的（不因一张坏图整条鱼消失）",
  fishPartsFromAssembly({ resourcePath: [{ slot: "body", path: "assets/fish/blue-tang.png" }, { slot: "tail", path: `${CDN}/t.png` }] }),
  { tail: `${CDN}/t.png` });
chkTrue("过滤器就是 IMAGE_SOURCE_RE（不是另写一套规则）",
  /if\(slot && path && IMAGE_SOURCE_RE\.test\(path\)\) parts\[slot\] = path;/.test(extractFunction(source, "fishPartsFromAssembly")));
chkTrue("旧格式字符串分支也走同一道过滤",
  /const path = typeof entry === "string" \? entry : String\(\(entry && entry\.path\) \|\| ""\)\.trim\(\);/.test(extractFunction(source, "fishPartsFromAssembly")));

console.log("\n--- F2c：IMAGE_SOURCE_RE 自身 ---");
chkTrue("认 http / https 的图片地址", IMAGE_SOURCE_RE.test(`${CDN}/a.png`) && IMAGE_SOURCE_RE.test("http://x.com/a.webp"));
chkTrue("认带查询串 / 锚点的地址", IMAGE_SOURCE_RE.test(`${CDN}/a.png?v=2`) && IMAGE_SOURCE_RE.test(`${CDN}/a.png#x`));
chkTrue("不认相对路径", !IMAGE_SOURCE_RE.test("assets/fish/x.png") && !IMAGE_SOURCE_RE.test("./x.png"));
chkTrue("不认协议相对地址（//host/x.png 线上同样取不到）", !IMAGE_SOURCE_RE.test("//cdn.example.com/x.png"));
chkTrue("不认非图片扩展名", !IMAGE_SOURCE_RE.test(`${CDN}/a.txt`) && !IMAGE_SOURCE_RE.test(`${CDN}/a`));

console.log("\n--- F5：feedReaction 投喂开关 ---");
chk("未设置 feedReaction → 默认会吃", fishReactsToFeed({}), true);
chk("feedReaction:true → 会吃", fishReactsToFeed({ feedReaction: true }), true);
chk("feedReaction:false → 不吃", fishReactsToFeed({ feedReaction: false }), false);
chk("fish 为 null → 不崩（会吃）", fishReactsToFeed(null), true);

console.log("\n----");
console.log(`fish-assembly.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
