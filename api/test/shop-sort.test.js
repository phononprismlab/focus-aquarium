// 商店排序：v1.0 按类型排（顺序跟商店标签栏一致），同类型内按 id。
//
// 以前一律按 id 排（fish001 / decoration001 / background001 / sand001 / sound001 交错出现），
// 玩家想"看看有哪些背景"得在整张网格里翻。
//
// 这里锁三件事：
//   1. 分组顺序 = 标签栏顺序（从 HTML 里读 data-category 来比，不写死两份）
//   2. 同类型内仍然按 id（fish001 在 fish002 前）
//   3. 认不出的类型沉到最后 —— 后台新加了类型但这里还没登记时，不能挤在鱼前面
//
// 运行：node test/shop-sort.test.js
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
  if (a === e) { console.log(`PASS | ${name} = ${String(a).slice(0, 110)}`); pass++; }
  else { console.log(`FAIL | ${name} 期望=${String(e).slice(0, 130)} 实际=${String(a).slice(0, 130)}`); fail++; }
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
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}
function extractConst(src, name) {
  const match = src.match(new RegExp(`const ${name} = [^\\n]*;`));
  if (!match) throw new Error(`index.html 里找不到常量 ${name}`);
  return match[0];
}

const factory = new Function(`${extractConst(source, "SHOP_CATEGORY_ORDER")}
${extractFunction(source, "sortShopItems")}
return { sortShopItems, SHOP_CATEGORY_ORDER };`);
const { sortShopItems, SHOP_CATEGORY_ORDER } = factory();

const ids = (items) => items.map(i => (i ? i.id : null));

console.log("--- 1. 分组顺序 = 标签栏顺序 ---");
{
  const tabs = [...source.matchAll(/<button type="button" class="v02-tab[^"]*" data-category="([^"]+)"/g)].map(m => m[1]);
  chk("标签栏里读到的分类", tabs, ["all", "fish", "decorations", "backgrounds", "sands", "sounds"]);
  chk("排序用的分类顺序 = 标签栏去掉「全部」", SHOP_CATEGORY_ORDER, tabs.slice(1));
}

console.log("\n--- 2. 分组 + 组内按 id ---");
{
  // 故意打乱：先给一组交错的输入，看输出是不是按类型聚起来。
  const input = [
    { id: "sound001", category: "sounds" },
    { id: "background002", category: "backgrounds" },
    { id: "fish002", category: "fish" },
    { id: "sand001", category: "sands" },
    { id: "decoration001", category: "decorations" },
    { id: "fish001", category: "fish" },
    { id: "background001", category: "backgrounds" },
    { id: "decoration002", category: "decorations" },
    { id: "sand002", category: "sands" }
  ];
  chk("输出按 鱼 → 装饰 → 背景 → 沙 → 白噪音", ids(sortShopItems(input)), [
    "fish001", "fish002",
    "decoration001", "decoration002",
    "background001", "background002",
    "sand001", "sand002",
    "sound001"
  ]);
  // 反向：旧的"一律按 id"会把上面这串排成 fish001,fish002,background001… 交错 —— 断言两者不同，
  // 证明上面那条不是自证。
  const legacy = ids(input.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))));
  chkTrue("与旧的纯 id 排序结果不同（反向验证）",
    JSON.stringify(legacy) !== JSON.stringify(ids(sortShopItems(input))));
  chk("旧的纯 id 排序确实会把类型打散（前 4 个）", legacy.slice(0, 4),
    ["background001", "background002", "decoration001", "decoration002"]);
}
{
  // 组内 id 序：fish002 / fish010 / fish001 → fish001, fish002, fish010（localeCompare 数字自然序）
  const input = [
    { id: "fish010", category: "fish" },
    { id: "fish002", category: "fish" },
    { id: "fish001", category: "fish" }
  ];
  chk("组内按 id", ids(sortShopItems(input)), ["fish001", "fish002", "fish010"]);
}

console.log("\n--- 3. 异常数据沉底 ---");
{
  const input = [
    { id: "weird001", category: "newstuff" },   // 后台新加的类型，这里还没登记
    { id: "fish001", category: "fish" },
    { id: "", category: "fish" },               // 没有 id，但类型认得 → 留在本组末尾
    { id: "sound001", category: "sounds" },
    { category: "sands" }                       // 没 id，类型认得 → 留在沙组末尾
  ];
  // 两条规则分开看：
  //   认不出的类型 → 全局沉底（weird001 在最后）
  //   认得类型但没 id → 只沉到本组末尾（不能因为没 id 就跨组乱跑）
  chk("认不出的类型排在最后、没 id 的留在本组末尾", ids(sortShopItems(input)), [
    "fish001", "", undefined, "sound001", "weird001"
  ]);
}
{
  // 线上真有一条脏商品 111（name "11"、price 0）—— 它 category 是 decorations，所以按类型正常落位。
  const input = [
    { id: "decoration001", category: "decorations" },
    { id: "111", category: "decorations" },
    { id: "fish001", category: "fish" }
  ];
  chk("数字 id 与字符串 id 混排不炸", ids(sortShopItems(input)), ["fish001", "111", "decoration001"]);
}
{
  chk("空数组", ids(sortShopItems([])), []);
  chk("null 项不炸，并且沉到最后（连类型都读不出来）",
    ids(sortShopItems([null, { id: "fish001", category: "fish" }])), ["fish001", null]);
  chk("单个元素原样返回", ids(sortShopItems([{ id: "fish001", category: "fish" }])), ["fish001"]);
}

console.log("\n--- 4. 不改原数组 ---");
{
  const input = [{ id: "sound001", category: "sounds" }, { id: "fish001", category: "fish" }];
  const before = ids(input);
  sortShopItems(input);
  chk("输入数组顺序没被就地改掉（slice() 生效）", ids(input), before);
}

console.log("\n--- 5. 静态锚 ---");
{
  chkTrue("currentShopItems 走 sortShopItems（两个分支都要）",
    (source.match(/return sortShopItems\(/g) || []).length === 2);
  chkTrue("分类顺序常量在函数外面（一处定义，两处消费）",
    source.indexOf("const SHOP_CATEGORY_ORDER") < source.indexOf("function sortShopItems"));
  chkTrue("注释里写清 v1.0 的规则和「以后再加」的边界",
    /v1\.0 按类型排/.test(source) && /新品置前/.test(source));
}

console.log(`\n===== 商店排序测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
