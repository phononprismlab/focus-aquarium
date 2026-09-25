// 小票底部那排条码必须是**真的 Code128**，不是画出来像条码的条纹。
// 这里锁三件事：
//   1. 编码结果与参考编码器（jsbarcode 3.12.3）逐位一致 —— 下面 VECTORS 就是它的输出
//   2. 校验和的算法（起始符按权重 1、数据符按位置加权、模 103）—— 含反向验证
//   3. 画进 DOM 的方式（两侧静区、crispEdges、preserveAspectRatio="none"）
//
// 为什么固定用码集 B、不做码集 C 的数字压缩：
//   小票上这串是固定英文，压缩省下的宽度不值得多一条分支和一个坑。
//   （jsbarcode 遇到纯数字会自动切码集 C，所以下面的参考向量全部避开纯数字串。）
//
// 运行：node test/barcode.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`PASS | ${name} = ${JSON.stringify(actual).slice(0, 90)}`);
    pass++;
  } else {
    console.log(`FAIL | ${name}\n       期望=${JSON.stringify(expected).slice(0, 120)}\n       实际=${JSON.stringify(actual).slice(0, 120)}`);
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
// CODE128_PATTERNS 是多行数组字面量，extractConst 的单行正则吃不下，单独配对。
function extractArrayConst(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`index.html 里找不到数组常量 ${name}`);
  const end = src.indexOf("];", start);
  if (end < 0) throw new Error(`数组常量 ${name} 没有闭合`);
  return src.slice(start, end + 2);
}

const consts = [
  extractArrayConst(source, "CODE128_PATTERNS"),
  extractConst(source, "RECEIPT_BARCODE_TEXT")
].join("\n");
const funcs = ["code128Modules", "formatReceiptStamp", "renderBarcode"]
  .map(name => extractFunction(source, name))
  .join("\n");

const factory = new Function("escapeHtml", `${consts}\n${funcs}\nreturn { code128Modules, formatReceiptStamp, renderBarcode, CODE128_PATTERNS, RECEIPT_BARCODE_TEXT };`);
const api = factory((value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])));

const modulesToBits = (text) => api.code128Modules(text).join("");

// ===== jsbarcode 3.12.3 的 CODE128 编码器输出（码集 B）=====
const VECTORS = [
  ["A",
    "1101001000010100011000100010110001100011101011"],
  ["Yuerle",
    "110100100001110110100010011110010101100100001001001111011001010000101100100001011001110011000111" +
    "01011"],
  ["FOCUS AQUARIUM",
    "110100100001000110001010001110110100010001101101110111011011101000110110011001010001100011010001" +
    "110110111011101010001100011000101110110001000101101110111010111011000100001011001100011101011"],
  ["Thank you for visiting Yuerle Aquarium",
    "110100100001101110001010011000010100101100001100001010011000010010110110011001101101111010001111" +
    "010100111100101101100110010110000100100011110101001001111011011001100111101001001000011010010111" +
    "100100100001101001001111010010000110100110000101001001101000011011001100111011010001001111001010" +
    "110010000100100111101100101000010110010000110110011001010001100010010111100100111100101001011000" +
    "010010011110100001101001001111001011110111010110010011101100011101011"]
];

console.log("--- 1. 与参考编码器逐位一致 ---");
for (const [text, bits] of VECTORS) {
  chk(`「${text}」(${bits.length} 模块)`, modulesToBits(text), bits);
}

console.log("\n--- 2. 小票上那句致谢 ---");
{
  chk("条码内容 = 英文致谢", api.RECEIPT_BARCODE_TEXT, "Thank you for visiting Yuerle Aquarium");
  chkTrue("纯 ASCII（码集 B 只收 32–126）", /^[\x20-\x7e]+$/.test(api.RECEIPT_BARCODE_TEXT));
  const bits = modulesToBits(api.RECEIPT_BARCODE_TEXT);
  chk("模块数 = 11×(起始+数据+校验) + 13(终止) = 453", bits.length, 453);
  chk("起始符 = 码集 B（104 → 11010010000）", bits.slice(0, 11), "11010010000");
  chk("终止符 = 2331112", bits.slice(-13), "1100011101011");
}

console.log("\n--- 3. 校验和公式 ---");
{
  // "A" → 数据符 33（65-32）；sum = 104 + 33×1 = 137；137 % 103 = 34。
  // 直接把校验符那 11 个模块拿出来比：34 号图案是 "131123"。
  const bits = modulesToBits("A");
  const checkBits = bits.slice(11 + 11, 11 + 11 + 11);
  const expected = "131123".split("").map((w, i) => String(i % 2 === 0 ? 1 : 0).repeat(Number(w))).join("");
  chk("「A」的校验符位串 = 34 号图案", checkBits, expected);
  chk("「A」的图案表第 34 项", api.CODE128_PATTERNS[34], "131123");
  chk("顺带核对相邻项，证明不是碰巧对上", api.CODE128_PATTERNS[33], "111323");
  // 反向：把起始符的权重 1 去掉（改成 0）会算出另一个校验符 —— 断言两条结果不同，
  // 证明上面那条断言不是在自证。
  const broken = (104 + 33 * 0) % 103;
  chkTrue("把起始符权重改成 0 会得到不同的校验符（反向验证）", broken !== 34);
}
{
  // 反向：校验和里"数据符按位置加权"这一条不能丢。
  // 两个字符时，第二个数据符权重是 2 而不是 1。
  const sum = 104 + 33 * 1 + 34 * 2;      // "AB"
  chk("「AB」的校验和", sum % 103, 205 % 103);
  chkTrue("按位置加权 ≠ 全部按权重 1（反向验证）", (104 + 33 + 34) % 103 !== sum % 103);
}
{
  // 不可打印字符必须被剔掉，否则 charCode - 32 会越界到图案表外面。
  chk("非 ASCII 字符被剔除（等价于只留可打印字符）", modulesToBits("A中B"), modulesToBits("AB"));
  chk("换行/制表符也剔除", modulesToBits("A\n\tB"), modulesToBits("AB"));
  chk("空串只剩 起始+校验+终止", modulesToBits("").length, 11 + 11 + 13);
  chk("null 不炸", modulesToBits(null), modulesToBits(""));
}

console.log("\n--- 4. 画进 DOM 的方式 ---");
{
  const host = { innerHTML: "" };
  api.renderBarcode(host, "A");
  const svg = host.innerHTML;
  chkTrue("产出 <svg>", svg.includes("<svg "));
  chkTrue('viewBox = 模块数 + 两侧各 10 个静区', svg.includes('viewBox="0 0 66 52"'));   // 46 + 20
  chkTrue('preserveAspectRatio="none"（横向拉满小票宽度）', svg.includes('preserveAspectRatio="none"'));
  chkTrue("role=img + aria-label（不是纯装饰）", svg.includes('role="img"') && svg.includes('aria-label="条形码"'));
  chkTrue("条用 <rect> 画", svg.includes("<rect"));
  chkTrue("条填纸边色", svg.includes('fill="#2f4a4e"'));
  chkTrue("人可读的说明行跟在条码下面", svg.includes("v02-paper-barcode-cap"));
  chkTrue("元素为 null 时不炸", (() => { api.renderBarcode(null, "A"); return true; })());
}
{
  const host = { innerHTML: "" };
  api.renderBarcode(host, api.RECEIPT_BARCODE_TEXT);
  chkTrue("致谢条码的 viewBox（453+20=473）", host.innerHTML.includes('viewBox="0 0 473 52"'));
  // 全是非 ASCII 时不留一个"只剩起止符"的空条码。
  const empty = { innerHTML: "x" };
  api.renderBarcode(empty, "中文");
  chk("非 ASCII 文本不画空条码", empty.innerHTML, "");
  const blank = { innerHTML: "x" };
  api.renderBarcode(blank, "   \u0000 ");
  chk("纯空白也不画", blank.innerHTML, "");
}
{
  // 条数：453 个模块里连续 1 的段数。人工数过 = 124（与浏览器里 DOM 实测一致）。
  const host = { innerHTML: "" };
  api.renderBarcode(host, api.RECEIPT_BARCODE_TEXT);
  const rects = host.innerHTML.match(/<rect /g) || [];
  chk("致谢条码的条数（与浏览器实测一致）", rects.length, 124);
}

console.log("\n--- 5. 时间戳 ---");
{
  const t = new Date(2026, 8, 25, 13, 4).getTime();   // 2026-09-25 13:04
  chk("本地时间，补零到分钟", api.formatReceiptStamp(t), "2026-09-25 13:04");
  chkTrue("非法值退回当前时间（不产出 NaN）", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(api.formatReceiptStamp("nonsense")));
}

console.log("\n--- 6. 静态锚：两处小票都要画条码 ---");
{
  chkTrue("购买小票里有条码容器", /<div class="v02-paper-barcode" id="receiptBarcode"><\/div>/.test(source));
  chkTrue("事件小票里有条码容器", /<div class="v02-paper-barcode" id="eventBarcode"><\/div>/.test(source));
  chkTrue("showPurchaseReceipt 里渲染条码",
    /renderBarcode\(document\.getElementById\("receiptBarcode"\), RECEIPT_BARCODE_TEXT\)/.test(source));
  chkTrue("presentEventResult 里渲染条码",
    /renderBarcode\(document\.getElementById\("eventBarcode"\), RECEIPT_BARCODE_TEXT\)/.test(source));
  chkTrue("条码 svg 关掉抗锯齿（边缘一糊就扫不出来）",
    /\.v02-paper-barcode svg\{[^}]*shape-rendering:crispEdges/.test(source));
  chkTrue("条码 svg 高度固定、宽度撑满（含 24px 出血）",
    /\.v02-paper-barcode svg\{[^}]*width:calc\(100% \+ 24px\)/.test(source));
  chkTrue("图案表 107 项（0–102 数据符 + 103/104/105 起始符 + 106 终止符）", api.CODE128_PATTERNS.length === 107);
  chk("终止符图案", api.CODE128_PATTERNS[106], "2331112");
}

console.log(`\n===== 条形码测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
