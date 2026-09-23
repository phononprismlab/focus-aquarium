// F9 回归测试：Tags 归一化与匹配（随机事件系统按 tag 关联资源的地基）。
//
// 沿用项目约定：按函数名从 index.html 抽取真实源码到沙箱里跑，不手抄实现。
// 运行：node test/tags.test.js
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

const { normalizeTags, itemHasTag } = new Function(`
${extractFunction(source, "normalizeTags")}
${extractFunction(source, "itemHasTag")}
return { normalizeTags, itemHasTag };`)();

console.log("--- normalizeTags ---");
chk("数组原样（去空白）", normalizeTags(["a", " b ", "c"]), ["a", "b", "c"]);
chk("英文逗号分隔", normalizeTags("a, b"), ["a", "b"]);
chk("中文逗号分隔", normalizeTags("a，b"), ["a", "b"]);
chk("空格分隔", normalizeTags("a b"), ["a", "b"]);
chk("混合分隔", normalizeTags("a, b，c"), ["a", "b", "c"]);
chk("空字符串 → []", normalizeTags(""), []);
chk("null → []", normalizeTags(null), []);
chk("undefined → []", normalizeTags(undefined), []);
chk("数组里的空项被过滤", normalizeTags(["a", "  ", "", "b"]), ["a", "b"]);
chk("数字 → []", normalizeTags(42), []);

console.log("\n--- itemHasTag ---");
chk("数组命中", itemHasTag({ tags: ["undersea-treasure"] }, "undersea-treasure"), true);
chk("字符串命中", itemHasTag({ tags: "undersea-treasure" }, "undersea-treasure"), true);
chk("大小写不敏感", itemHasTag({ tags: ["Undersea-Treasure"] }, "undersea-treasure"), true);
chk("多 tag 中命中一个", itemHasTag({ tags: ["a", "b"] }, "b"), true);
chk("没命中", itemHasTag({ tags: ["a"] }, "b"), false);
chk("无 tags 字段", itemHasTag({}, "a"), false);
chk("item 为 null", itemHasTag(null, "a"), false);
chk("tag 为空 → false", itemHasTag({ tags: ["a"] }, ""), false);
chk("tag 为 null → false", itemHasTag({ tags: ["a"] }, null), false);

console.log("\n--- 接线检查（防止字段被接上又悄悄掉线）---");
const adminSource = fs.readFileSync(path.join(here, "..", "..", "admin.html"), "utf8");
// 后台两个表单（商品 / 鱼种）都要把 tags 输入解析成数组再提交
chk("admin 商品表单解析 tags", (adminSource.match(/parseTagsInput\(data\.tags\)/g) || []).length >= 2, true);
chk("admin 用 tagsToInput 回填（不再把数组直接 esc）", /esc\(item\.tags\)/.test(adminSource), false);
chk("admin tags 输入框恰好 2 个（商品 + 鱼种）", (adminSource.match(/name="tags"/g) || []).length, 2);
// 玩家端把 tags 落到 DOM 上，事件系统才有挂钩点
chk("玩家端鱼元素挂 data-tags", /el\.dataset\.tags=normalizeTags\(/.test(source), true);
chk("玩家端商品卡片挂 data-tags", /d\.dataset\.tags=normalizeTags\(/.test(source), true);

console.log("\n----");
console.log(`tags.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
