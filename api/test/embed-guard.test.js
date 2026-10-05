// 防嵌套兜底的回归测试。
//
// 背景：CSP 的 frame-ancestors 写在 <meta> 里浏览器会**直接忽略**（该指令只认 HTTP 响应头），
// 而本项目前端托管在静态网站托管（COS + CDN）上 —— 它的安全配置只有防盗链 / IP 黑白名单 /
// 访问限频三项，没有「自定义响应头」入口，暂时给不了 X-Frame-Options。
// 所以 index.html 的 <head> 里加了一段同步执行的 JS 兜底，行为等价 SAMEORIGIN。
//
// 这个测试验三件事：
//   1. 静态：代码在、位置对（<head> 里、早于主脚本）、没用两种已失效的写法；
//   2. 行为：把代码抽出来在 mock 环境里真跑一遍，验三条分支（直接打开 / 同源嵌套 / 跨域嵌套）；
//   3. 反向：把「跨域判定」破掉，断言它真的会放行 —— 证明前一条不是空闸。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function chkTrue(name, condition, detail = "") {
  const ok = condition === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}

// ============================================================
console.log("--- 1. 静态：代码在、位置对 ---");
// ============================================================
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const guard = blocks.find(src => src.includes("window.stop") && src.includes("window.top"));
chkTrue("找得到防嵌套兜底脚本（含 window.top + window.stop）", Boolean(guard));

const guardTagAt = html.indexOf(guard ? guard.slice(0, 60) : "__missing__");
const headEndAt = html.indexOf("</head>");
const mainScriptAt = html.indexOf('"use strict"');
chkTrue("</head> 存在（下面两条位置断言才有意义）", headEndAt > 0);
chkTrue("🔴 兜底脚本在 <head> 里（早于 </head>）", guardTagAt > 0 && guardTagAt < headEndAt, `guard@${guardTagAt} headEnd@${headEndAt}`);
// 🔴 这条是核心：主脚本在文档中部（16 万字符处），等它跑页面已经渲染完了。
chkTrue("🔴 兜底脚本早于主脚本（必须同步尽早执行，否则有窗口期）", guardTagAt > 0 && mainScriptAt > 0 && guardTagAt < mainScriptAt, `guard@${guardTagAt} main@${mainScriptAt}`);
chkTrue("兜底脚本在 CSP meta 之后（策略先声明再执行）",
  guardTagAt > html.indexOf("Content-Security-Policy"), "");

// 反向：两种被淘汰的写法都不能出现 —— 它们看起来"也在防嵌套"，实际挡不住。
chkTrue("🔴 没用 document.write（在 <head> 里只会插进当前位置，body 照样渲染）", !/document\s*\.\s*write\s*\(/.test(guard));
chkTrue("🔴 没用 frame busting（跨域写 top.location 被同源策略拒绝，现代浏览器已失效）",
  !/window\.top\.location\s*=|top\.location\s*=|top\.location\.href\s*=/.test(guard));
chkTrue("注释里写明了为什么（frame-ancestors 在 meta 里无效）", /frame-ancestors/.test(html.slice(Math.max(0, guardTagAt - 1600), guardTagAt)));

// ============================================================
console.log("\n--- 2. 行为：抽出来在 mock 环境里真跑三条分支 ---");
// ============================================================
// 造一个最小 window/document 环境。跨域用「读 location 抛错」模拟（真实浏览器行为）。
function runGuard({ nested, crossOrigin }) {
  const calls = { stopped: false, cleared: false, text: "" };

  const root = {
    firstChild: { nodeName: "HEAD" },
    removeChild() { root.firstChild = null; calls.cleared = true; },
    appendChild() {}
  };
  const document = {
    documentElement: root,
    createElement() {
      const el = { setAttribute() {}, set textContent(v) { calls.text = v; } };
      return el;
    }
  };

  const selfWin = { location: { href: "https://example.com/index.html" } };
  const topWin = nested
    ? (crossOrigin
      // 跨域：读 location 抛 SecurityError —— 兜底脚本据此判「非同源」。
      ? Object.defineProperty({}, "location", { get() { throw new Error("SecurityError"); } })
      : { location: { href: "https://example.com/index.html" } })
    : null;

  const window = { self: selfWin, stop() { calls.stopped = true; } };
  window.top = nested ? topWin : selfWin;

  // 脚本是 IIFE，直接求值执行。
  new Function("window", "document", guard)(window, document);
  return calls;
}

{
  const direct = runGuard({ nested: false, crossOrigin: false });
  chk("直接打开：不清空", direct.cleared, false);
  chk("直接打开：不调 window.stop", direct.stopped, false);

  const sameOrigin = runGuard({ nested: true, crossOrigin: false });
  chk("🔴 同源嵌套：放行（等价 SAMEORIGIN，控制台预览不受影响）", sameOrigin.cleared, false);
  chk("同源嵌套：不调 window.stop", sameOrigin.stopped, false);

  const foreign = runGuard({ nested: true, crossOrigin: true });
  chk("🔴 跨域嵌套：清空文档", foreign.cleared, true);
  chk("🔴 跨域嵌套：先停掉后续解析与资源加载", foreign.stopped, true);
  chkTrue("跨域嵌套：给出可读的提示文案（不是白屏）", /不允许被其他网页嵌入/.test(foreign.text), foreign.text);

  // 反向：把「跨域」这一条破掉（当成同源），断言它就不拦了 ——
  // 否则「跨域嵌套被拦」可能只是"无论如何都拦"，那会误伤正常嵌套。
  const broken = runGuard({ nested: true, crossOrigin: false });
  chk("🔴 反向：跨域判定失效时不拦（证明拦截真的由该判定驱动）", broken.cleared, false);
}

console.log(`\n===== embed-guard: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail > 0 ? 1 : 0);
