// 商店卡片上的预览图必须是**裸地址**，不能是 CSS 值。
//
// 这里锁的 bug（09-25 线上实测复现）：
//   renderShop 里 previewSrc = item.previewImage || visualForItem(...).image，
//   而 visualForItem().image 是 cssFromImagePath() 的产物：
//     url("https://…png?token=…") center / cover no-repeat
//   把它塞进 <img src> → 浏览器当相对路径请求 →
//     404 https://…webapps.tcloudbase.com/url(%22https://…png?token=…
//   → onerror="this.remove()" 把 <img> 删掉 → 卡片一片空白
//   （background001 的 previewClass 是空串，所以那件卡片真就是空白）。
//
// 鱼缸不受影响：它用的是 .css。
// 运行：node test/shop-preview.test.js
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

const consts = [
  extractConst(source, "VISUAL_FIELD_BY_CATEGORY"),
  extractConst(source, "IMAGE_SOURCE_RE")
].join("\n");
// shopPreviewSrc 依赖 visualForItem，visualForItem 依赖 itemImagePaths / cssFromImagePath ——
// 整条链都抽真实实现，避免测试和线上走偏。
const funcs = ["itemResourcePaths", "itemImagePaths", "itemImagePath", "cssFromImagePath", "visualForItem", "shopPreviewSrc"]
  .map(name => extractFunction(source, name))
  .join("\n");

const DEFAULT_DATA = {
  defaults: { backgrounds: { css: "linear-gradient(fallback)" }, sands: { css: "#cccccc" }, fish: { emoji: "🐠" } },
  visuals: { backgrounds: { bg001: { css: "linear-gradient(builtin)" } } }
};

function build(items) {
  const factory = new Function(
    "DEFAULT_DATA",
    "currentShopItems",
    `${consts}\n${funcs}\nreturn { shopPreviewSrc, visualForItem };`
  );
  return factory(DEFAULT_DATA, () => items);
}

const SIGNED = "https://x.api.tcloudbasegateway.com/v1/storages/object/sign/aquarium-assets/images/1.png?token=abc";

console.log("--- 1. 后台上传了图：卡片拿到的是裸地址 ---");
{
  const s = build([{ id: "bg001", category: "backgrounds", resourcePath: [SIGNED] }]);
  const src = s.shopPreviewSrc({ id: "bg001", category: "backgrounds", resourcePath: [SIGNED] });
  chk("返回签名地址本身", src, SIGNED);
  chkTrue("不含 url( —— 否则会被当相对路径请求", !src.includes("url("));
  chkTrue("不含 center / cover（那是 CSS 的写法）", !src.includes("center / cover"));
}
{
  // 反向：旧的取法（.image）会拿到 CSS 值，两条断言必须能把它抓出来。
  const item = { id: "bg001", category: "backgrounds", resourcePath: [SIGNED] };
  const s = build([item]);
  const legacy = s.visualForItem("backgrounds", "bg001").image;
  chkTrue("旧写法（.image）确实带 url( —— 这就是线上 404 的根因", legacy.includes("url("));
  chkTrue("新写法与旧写法不是同一个值", s.shopPreviewSrc(item) !== legacy);
}

console.log("\n--- 2. 后台单独填了预览图：预览图优先 ---");
{
  const s = build([{ id: "bg001", category: "backgrounds", previewImage: "https://cdn/cover.png", resourcePath: [SIGNED] }]);
  chk("previewImage 顶上",
    s.shopPreviewSrc({ id: "bg001", category: "backgrounds", previewImage: "https://cdn/cover.png", resourcePath: [SIGNED] }),
    "https://cdn/cover.png");
}
{
  const s = build([]);
  chk("预览图两边的空格要 trim",
    s.shopPreviewSrc({ id: "x", category: "backgrounds", previewImage: "  https://cdn/a.png  " }),
    "https://cdn/a.png");
}

console.log("\n--- 3. 不该出图的一律返回空串（不出空 <img>） ---");
{
  // 鱼的 resourcePath 是按插槽拼的（body/tail/fin/shadow），抽第一张可能只是条尾巴。
  const s = build([{ id: "fish001", category: "fish", resourcePath: ["https://cdn/tail.png"] }]);
  chk("鱼不套用 resourcePath", s.shopPreviewSrc({ id: "fish001", category: "fish", resourcePath: ["https://cdn/tail.png"] }), "");
}
{
  const s = build([{ id: "bg001", category: "backgrounds" }]);
  chk("什么都没配 → 空串", s.shopPreviewSrc({ id: "bg001", category: "backgrounds" }), "");
}
{
  // 线上种子数据里全是 assets/backgrounds/background001.webp 这类相对路径，线上实测全 404。
  const s = build([{ id: "bg001", category: "backgrounds", resourcePath: ["assets/backgrounds/background001.webp"] }]);
  chk("相对路径死链不产生请求", s.shopPreviewSrc({ id: "bg001", category: "backgrounds", resourcePath: ["assets/backgrounds/background001.webp"] }), "");
}
{
  const s = build([{ id: "snd001", category: "sounds", resourcePath: ["assets/sounds/a.mp3"] }]);
  chk("音频不产生 <img>", s.shopPreviewSrc({ id: "snd001", category: "sounds", resourcePath: ["assets/sounds/a.mp3"] }), "");
}
{
  const s = build([]);
  chk("空 item 不炸", s.shopPreviewSrc(null), "");
}

console.log("\n--- 4. 静态锚：renderShop 必须走这个函数 ---");
{
  chkTrue("renderShop 里用的是 shopPreviewSrc(item)",
    /const previewSrc\s*=\s*shopPreviewSrc\(item\)/.test(source));
  // 反向：旧写法不能复活。它的特征是「previewImage || (…visualForItem…image)」连在一起。
  chkTrue("旧写法（把 .image 直接当 src）已不存在",
    !/previewImage\s*\|\|\s*\(item\.category\s*===\s*"fish"\s*\?\s*""\s*:\s*visualForItem/.test(source));
  chkTrue("visualForItem 仍然提供 imageUrl 字段",
    /visual\.imageUrl\s*=\s*itemImagePaths\(item\)\[0\]\s*\|\|\s*""/.test(source));
}

console.log(`\n===== 商店预览图测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
