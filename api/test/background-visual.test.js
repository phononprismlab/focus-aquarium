// 后台上传的背景 / 底砂图片要真的铺到鱼缸上。
//
// 这里锁的 bug：鱼缸背景由 visualForItem("backgrounds", id).css 渲染，
// 而这个函数**只认 item.visual** —— 后台「装点鱼缸配置」里根本没有 visual 的录入入口，
// 上传的图片被存进 previewImage / resourcePath，于是图传上去了、鱼缸永远还是内置渐变。
//
// 修法：css 类（backgrounds / sands）在 visual 之外再兜一层「上传的图片」，
// 且只认图片扩展名 —— 背景音商品也会把 mp3 挂到 resourcePath，不加过滤会铺成一片空白。
// 运行：node test/background-visual.test.js
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

// 按函数名做花括号配对，抽出一整个函数体（不手抄实现，避免测试和线上走偏）。
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

const consts = [
  extractConst(source, "VISUAL_FIELD_BY_CATEGORY"),
  extractConst(source, "IMAGE_SOURCE_RE")
].join("\n");
const funcs = ["itemResourcePaths", "itemImagePaths", "itemImagePath", "cssFromImagePath", "visualForItem"]
  .map(name => extractFunction(source, name))
  .join("\n");

const BUILTIN_BG = "linear-gradient(builtin)";
const BUILTIN_SAND = "#eeddbb";
const BUILTIN_PLANT = "aq-plant-green";
const DEFAULT_DATA = {
  defaults: { backgrounds: { css: "linear-gradient(fallback)" }, sands: { css: "#cccccc" } },
  visuals: {
    backgrounds: { bg001: { css: BUILTIN_BG } },
    sands: { sand001: { css: BUILTIN_SAND } },
    decorations: { deco001: { class: BUILTIN_PLANT } }
  }
};

// 沙箱里跑真实实现：currentShopItems 由用例注入，聚焦取图逻辑本身。
function build(items) {
  const factory = new Function(
    "DEFAULT_DATA",
    "currentShopItems",
    `${consts}\n${funcs}\nreturn { visualForItem, cssFromImagePath, itemImagePath };`
  );
  return factory(DEFAULT_DATA, () => items);
}

console.log("--- 1. 背景：上传的图要变成能铺满的 CSS ---");
{
  const s = build([{ id: "bg001", category: "backgrounds", previewImage: "https://cdn/a.png" }]);
  chk("previewImage 生效（url + 铺满）",
    s.visualForItem("backgrounds", "bg001").css,
    'url("https://cdn/a.png") center / cover no-repeat');
}
{
  const s = build([{ id: "bg001", category: "backgrounds", resourcePath: ["https://cdn/b.jpg"] }]);
  chk("resourcePath 字符串数组也生效",
    s.visualForItem("backgrounds", "bg001").css,
    'url("https://cdn/b.jpg") center / cover no-repeat');
}
{
  // 鱼的插槽格式：[{slot,path}]，背景商品也可能被存成这个形状。
  const s = build([{ id: "bg001", category: "backgrounds", resourcePath: [{ slot: "body", path: "https://cdn/c.webp" }] }]);
  chk("resourcePath 是 {slot,path} 也取得到 path",
    s.visualForItem("backgrounds", "bg001").css,
    'url("https://cdn/c.webp") center / cover no-repeat');
}
{
  const s = build([{ id: "bg001", category: "backgrounds" }]);
  chk("没有图片时退回内置渐变（不是空白）",
    s.visualForItem("backgrounds", "bg001").css, BUILTIN_BG);
}
{
  // 云存储的签名链接带 query，不能因为多了 ?sign= 就认不出是图片。
  const s = build([{ id: "bg001", category: "backgrounds", previewImage: "https://cdn/d.png?sign=abc&t=1" }]);
  chkTrue("带签名 query 的 URL 仍识别为图片",
    s.visualForItem("backgrounds", "bg001").css.startsWith('url("https://cdn/d.png?sign=abc&t=1")'));
}

console.log("\n--- 2. 反向：不该铺的一律不铺 ---");
{
  // 背景音商品走同一个「装点鱼缸配置」，resourcePath 里挂的是 mp3。
  const s = build([{ id: "bg001", category: "backgrounds", resourcePath: ["https://cdn/water.mp3"] }]);
  chk("mp3 不当背景图（否则鱼缸一片空白）",
    s.visualForItem("backgrounds", "bg001").css, BUILTIN_BG);
}
{
  const s = build([{ id: "bg001", category: "backgrounds", previewImage: "https://cdn/not-image.txt" }]);
  chk("非图片扩展名不生效",
    s.visualForItem("backgrounds", "bg001").css, BUILTIN_BG);
}
{
  // 手工 visual 是最高优先级：后台将来加了录入入口，图不能反过来盖掉它。
  const s = build([{ id: "bg001", category: "backgrounds", visual: "red", previewImage: "https://cdn/a.png" }]);
  chk("visual 优先于上传的图",
    s.visualForItem("backgrounds", "bg001").css, "red");
}

console.log("\n--- 3. 底砂同规则（但 fit 单独一档）---");
{
  // 🔴 2026-09-25 修：沙子是「透明底 + 高度约 20%」的条带图，用 cover 会让近方形图按较大边
  //    缩放，透明区正好铺满可见区域 → 沙子完全不显示（线上实测）。改成按高度撑满 + 横向平铺。
  const s = build([{ id: "sand001", category: "sands", previewImage: "https://cdn/sand.png" }]);
  chk("底砂吃上传的图，但按高度撑满（不是 cover）",
    s.visualForItem("sands", "sand001").css,
    'url("https://cdn/sand.png") center bottom / auto 100% repeat-x');
  chk("沙子 fit 由 category 单独判定",
    s.cssFromImagePath("https://cdn/sand.png", "sand"),
    'url("https://cdn/sand.png") center bottom / auto 100% repeat-x');
  chk("背景仍走 cover（不受沙子改动影响）",
    s.cssFromImagePath("https://cdn/bg.png", "cover"),
    'url("https://cdn/bg.png") center / cover no-repeat');
  chk("装饰仍走 contain（不受沙子改动影响）",
    s.cssFromImagePath("https://cdn/deco.png", "contain"),
    'url("https://cdn/deco.png") center bottom / contain no-repeat');
}
{
  const s = build([{ id: "sand001", category: "sands" }]);
  chk("底砂无图退回内置", s.visualForItem("sands", "sand001").css, BUILTIN_SAND);
}

console.log("\n--- 4. 路径里的引号不能提前闭合 url() ---");
{
  const s = build([]);
  chk("引号与反斜杠被清掉",
    s.cssFromImagePath('https://x/a"b\\c.png'), 'url("https://x/abc.png") center / cover no-repeat');
  chk("空值不出 CSS", s.cssFromImagePath(""), "");
}

console.log("\n--- 5. 相对路径的种子资源是死链，不能拿来当背景 ---");
{
  // 线上实测 assets/backgrounds/background001.webp 之类全是 404：
  // 拿它铺背景会把好好的内置渐变换成一片空白，比不改还糟。
  // 后台上传走云存储，返回的都是带签名的 https 链接，不会被这条规则误伤。
  const s = build([{ id: "bg001", category: "backgrounds", resourcePath: ["assets/backgrounds/background001.webp"] }]);
  chk("相对路径不生效（退回内置渐变）", s.visualForItem("backgrounds", "bg001").css, BUILTIN_BG);
  chk("相对路径不算图片", s.visualForItem("backgrounds", "bg001").images.length, 0);
}

console.log("\n--- 6. 装饰件：上传的图也要显示在鱼缸里 ---");
{
  const s = build([{ id: "deco001", category: "decorations", resourcePath: ["https://cdn/back.png", "https://cdn/front.png"] }]);
  const v = s.visualForItem("decorations", "deco001");
  chk("两张图都留着（后景 + 前景）", v.images.length, 2);
  chkTrue("装饰用 contain 贴底（完整不裁切）", v.images[0].includes("center bottom / contain"));
  chkTrue("前景排在后景之后（叠上去盖住）", v.images[1].includes("front.png"));
}
{
  const s = build([{ id: "deco001", category: "decorations" }]);
  const v = s.visualForItem("decorations", "deco001");
  chk("没上传图时 images 为空", v.images.length, 0);
  chk("没图时仍走内置 CSS 水草", v.class, BUILTIN_PLANT);
}
{
  // 线上真实数据：有个装饰件的 resourcePath 是早期上传留下的本地文件名「罗莎奸笑搓手.jpg」，
  // 但预览图是有效的签名链接 —— 不能被那个无效值挡住。
  const s = build([{ id: "deco001", category: "decorations", resourcePath: ["罗莎奸笑搓手.jpg"], previewImage: "https://cdn/real.png" }]);
  chk("资源位是无效文件名时，预览图顶上",
    s.visualForItem("decorations", "deco001").images,
    ['url("https://cdn/real.png") center bottom / contain no-repeat']);
}

console.log(`\n===== 背景图片测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
