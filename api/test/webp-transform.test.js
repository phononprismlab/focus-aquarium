// 图片下发转 WebP（CloudBase imageMogr2）—— 2026-10-06。
//
// 背景：素材是直接从设计工具导出的 PNG，几张背景用 PNG 装了照片级内容
// （每像素 0.49~0.52 字节），单张 758~803KB；同样 1536×1024 的图存 JPEG 只要 52KB。
// 玩家进页面时多张图并发到达、谁先到谁先画 → 看起来就是「素材一栏一栏冒出来」。
//
// CloudBase 云存储自带 imageMogr2 图片处理，**在签名 URL 上同样生效**（实测 200，
// content-type 变 image/webp、magic 是 RIFF）。所以不用重传素材、不用装转码依赖，
// 只在下发 URL 时挂参数。本文件锁住「哪些该转、哪些绝不能转」的边界。
//
// 反向验证：把 WEBP_SOURCE_EXTENSIONS 改成包含 svg/gif，或去掉 resolveAudioPaths 里的
// withWebpTransform 调用，本文件会 FAIL。
//
// 跑法：node test/webp-transform.test.js
import fs from "node:fs";
import { withWebpTransform } from "../uploads.js";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}

const PARAM = "imageMogr2/format/webp/quality/80";
const signed = (ext) => `https://test-env.api.tcloudbasegateway.com/v1/storages/object/sign/aquarium-assets/images/abc.${ext}?token=xyz`;

console.log("--- 1. 静态位图：必须挂上转码参数 ---");
for (const ext of ["png", "jpg", "jpeg", "bmp", "avif"]) {
  const url = signed(ext);
  const out = withWebpTransform(url);
  chk(`.${ext} 会转 WebP`, out.includes(PARAM), true);
  chk(`.${ext} 原 URL 完整保留（签名不破坏）`, out.startsWith(url), true);
}
chk("原 URL 带 query 时用 & 连接", withWebpTransform(signed("png")).includes("?token=xyz&imageMogr2"), true);
chk("大写扩展名也认（.PNG）", withWebpTransform(signed("PNG")).includes(PARAM), true);
chk("混合大小写也认（.JpEg）", withWebpTransform(signed("JpEg")).includes(PARAM), true);

console.log("\n--- 2. 绝不能转的：矢量 / 动图 / 音频 / 已经是 webp ---");
for (const ext of ["svg", "gif", "webp", "mp3", "wav", "ogg", "m4a", "flac"]) {
  const url = signed(ext);
  chk(`.${ext} 原样返回`, withWebpTransform(url), url);
}
chk("SVG 是矢量，转位图会失真", withWebpTransform(signed("svg")).includes("imageMogr2"), false);
chk("GIF 是动图，转了只剩单帧", withWebpTransform(signed("gif")).includes("imageMogr2"), false);

console.log("\n--- 3. 非 http / 非字符串：原样返回 ---");
chk("相对路径不转（前端会静默忽略，这里也不该动）", withWebpTransform("assets/sands/sand002.webp"), "assets/sands/sand002.webp");
chk("未解析的 tcbpg:// 引用不转", withWebpTransform("tcbpg://aquarium-assets/images/x.png"), "tcbpg://aquarium-assets/images/x.png");
chk("空字符串原样", withWebpTransform(""), "");
chk("null 原样", withWebpTransform(null), null);
chk("undefined 原样", withWebpTransform(undefined), undefined);
chk("数字原样", withWebpTransform(42), 42);
chk("对象原样（不递归，只处理字符串）", JSON.stringify(withWebpTransform({ a: 1 })), JSON.stringify({ a: 1 }));

console.log("\n--- 4. 边界：不重复叠加 / 只看 pathname ---");
const once = withWebpTransform(signed("png"));
chk("已经带过参数就不再叠一层", withWebpTransform(once), once);
chk("只叠一次（参数只出现一次）", once.split("imageMogr2").length - 1, 1);
const noQuery = "https://cdn.example.com/a/x.png";
chk("没有 query 时用 ? 连接", withWebpTransform(noQuery), `${noQuery}?${PARAM}`);
const tricky = "https://cdn.example.com/download?file=x.png&token=1";
chk("扩展名只看 pathname，query 里的 .png 不算数", withWebpTransform(tricky), tricky);

console.log("\n--- 5. 锚：真的接进了下发链路 ---");
const src = fs.readFileSync(new URL("../uploads.js", import.meta.url), "utf8");
chk("resolveAudioPaths 里调用了 withWebpTransform", /return withWebpTransform\(await resolveCloudUrl\(value\)\)/.test(src), true);
chk("有环境变量开关（FISHTANK_IMAGE_WEBP=0 可关）", /FISHTANK_IMAGE_WEBP\s*!==\s*"0"/.test(src), true);
chk("排除清单里有 svg 和 gif 的注释说明", /SVG（矢量转位图会失真）/.test(src), true);

console.log("----");
console.log(`webp-transform.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
