// 账号「客户端」侧的回归测试（静态断言）。
//
// 为什么用静态断言而不是跑真浏览器：这一层踩过的坑全在浏览器里，而且症状**都不指向
// 真实原因**，排查一次要装 playwright + 拉真 Chrome，成本高到不会有人愿意重跑。但它们
// 在代码里的形态是唯一的、可以静态识别 —— 静态断言证明不了"跑得对"，但能保证"不会
// 悄悄改回错的样子"，这正是回归测试要拦住的事。
//
// 锁住的四个坑（每一个都真实发生过）：
//   1) signInWithCustomTicket 的参数必须是**函数**，不是票据字符串。
//      传字符串时 SDK 试图调用它 → "AuthError: e is not a function"，而且
//      **一个网络请求都不发** —— 看起来完全像"服务端配置错了"。
//   2) 它用 {data, error} 信封 resolve，失败**不抛异常**。不查 .error 就会把失败
//      当成功，报出"登录成功但 uid 为空"这种误导结论。
//   3) uid 在 auth.currentUser.uid / result.data.session.sub；而 result.data.user 是
//      服务端**原始**记录，字段叫 id，**没有 uid**。只读 ret.data.user.uid → undefined。
//   4) FISHTANK_API_BASE 本身已含 "/api"（index.html / admin.html 都写
//      `${API_BASE}/game/...`），再拼一次 "/api/health" 就是重复前缀，后端回一句
//      Cannot GET 的 HTML，前端报 "Unexpected token '<'"。
//
// 另外锁一个前端专属陷阱：ACCOUNT_UID 的声明位置。updateDevStatus() 在脚本顶层被
// **同步**调用一次，如果 ACCOUNT_UID 用 let 声明在它后面，TDZ 会抛 ReferenceError，
// 整个应用直接白屏。所以声明行必须早于所有调用点。
//
// ⚠️ 断言必须看「代码」不能看「注释」：注释里为了讲清反面例子会原样写出错误写法
//    （例如"再写一次 /api/... 会拼成 /api/api/health"），不剥掉注释就会自己把自己判红。
//
// 运行：node test/account-client.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");

let pass = 0;
let fail = 0;
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

// 统一成 LF：工作区文件在 Windows 上是 CRLF，多行正则不归一化必然匹配不到。
const norm = text => text.replace(/\r\n/g, "\n");
// 剥注释。⚠️ 不能用正则一把梭：注释正文里出现 `/api/game/*` 这类片段时，其中的
// `/*` 会被当成块注释起点，把后面大段代码一路吞掉 —— 曾经把 signInWithCustomTicket
// 整段吃掉，让 15 条断言凭空变红，而报错信息完全指不到注释上。这里逐字符扫描，
// 并且跳过字符串/模板串（字符串里的 // 与 /* 都不是注释）。
// 只删文本不删换行，所以行号不变（第 7 节依赖行号）。
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === ch) { j += 1; break; }
        // ⚠️ 单双引号在 JS 里不能跨行。被测文件是 HTML，正文里会有 don't / it's 这种
        //    不配对的撇号 —— 不当场退出的话，扫描器会一直停在"字符串里"，
        //    后面所有注释都剥不掉（表现为断言凭空变红）。
        if (text[j] === "\n" && ch !== "`") { break; }
        j += 1;
      }
      if (j > i + 1 && text[j - 1] === ch) {
        out += text.slice(i, j);
        i = j;
        continue;
      }
      // 没闭合 → 这个引号不是字符串起点，当普通字符继续扫。
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const checkRaw = norm(fs.readFileSync(path.join(repoRoot, "account-check.html"), "utf8"));
const playerRaw = norm(fs.readFileSync(path.join(repoRoot, "index.html"), "utf8"));
const checkCode = stripComments(checkRaw);
const playerCode = stripComments(playerRaw);

// ============================================================
console.log("--- 1. signInWithCustomTicket 必须传函数，不能传字符串 ---");
// ============================================================
for (const [label, src] of [["account-check.html", checkCode], ["index.html", playerCode]]) {
  const calls = [...src.matchAll(/signInWithCustomTicket\s*\(([^)]*)/g)].map(m => m[1].trim());
  chkTrue(`${label} 有调用 signInWithCustomTicket`, calls.length >= 1, `找到 ${calls.length} 处`);
  // 参数必须以 ( 或 function 开头 —— 即一个内联函数。
  const allFunctions = calls.length > 0 && calls.every(arg => /^(\(|function)/.test(arg));
  chkTrue(`${label} 参数是函数（不是字符串/变量）`, allFunctions, calls.join(" | "));
  // 反面：不能是裸标识符或字符串字面量。
  const bareArgs = calls.filter(arg => /^(["'`]|[A-Za-z_$][\w$.]*\s*$)/.test(arg));
  chk(`${label} 没有裸变量/字符串传参`, bareArgs, []);
}

// ============================================================
console.log("\n--- 2. 必须检查 {data,error} 信封的 error（失败不抛异常） ---");
// ============================================================
for (const [label, src] of [["account-check.html", checkCode], ["index.html", playerCode]]) {
  // ⚠️ 必须是"真的拿 error 做条件判断"。只断言"文中出现过 .error"是空闸 —— 把判断
  //    改成 if(false) 只留一句死代码，那种断言照样绿（反向验证时抓到过）。
  chkTrue(`${label} 用 result.error 做了条件判断`, /if\s*\([^)]*\.error[^)]*\)/.test(src));
  chkTrue(`${label} 有「登录失败」的分支（把 error 转成可读信息）`, /登录失败/.test(src));
}

// ============================================================
console.log("\n--- 3. uid 取值必须覆盖 currentUser.uid 与 session.sub ---");
// ============================================================
for (const [label, src] of [["account-check.html", checkCode], ["index.html", playerCode]]) {
  // 直接看 uid 的取值表达式，而不是在全文里捞 —— 全文捞容易被别处的 .uid 蒙对。
  const uidExpr = (src.match(/(?:const|let|var)\s+uid\s*=\s*([^;]*);/) || [null, ""])[1].trim();
  chkTrue(`${label} 找得到 uid 取值表达式`, uidExpr.length > 0, uidExpr);
  chkTrue(`${label} uid 取值含 SDK User 的 .uid`, /\.uid/.test(uidExpr));
  chkTrue(`${label} uid 取值含 session.sub 兜底`, /\.sub/.test(uidExpr));
  chkTrue(`${label} uid 取值含原始记录的 .id 兜底`, /\.id/.test(uidExpr));
  chkTrue(`${label} 用到了 auth.currentUser（SDK 的 User 对象）`, /auth\.currentUser/.test(src));
  // 反面：不能把 data.user 整个当成 uid 来源（那是原始记录，只有 id）。
  chkTrue(
    `${label} 没有把 data.user 直接当 user 对象取 .uid`,
    !/ret\.data\.user\s*\)\s*\|\|\s*auth\.currentUser/.test(src)
  );
}

// ============================================================
console.log("\n--- 4. 不能把 /api 拼两遍（FISHTANK_API_BASE 已含 /api） ---");
// ============================================================
for (const [label, src] of [["account-check.html", checkCode], ["index.html", playerCode]]) {
  chkTrue(`${label} 没有 API_BASE + "/api/..."`, !/API_BASE\s*\+\s*["'`]\/api\//.test(src));
  chkTrue(`${label} 没有 \${API_BASE}/api/...（模板串重复前缀）`, !/\$\{API_BASE\}\/api\//.test(src));
  chkTrue(`${label} 没有出现重复前缀的请求路径`, !/\/api\/api\//.test(src));
}

// ============================================================
console.log("\n--- 5. index.html：账号层不能拖累主流程 ---");
// ============================================================
chkTrue("有 FISHTANK_DISABLE_ACCOUNT 总开关", /FISHTANK_DISABLE_ACCOUNT/.test(playerCode));
chkTrue('SDK 是动态注入（createElement("script")）', /createElement\(["']script["']\)/.test(playerCode));
chkTrue("SDK 地址走常量 ACCOUNT_SDK_URL", /ACCOUNT_SDK_URL/.test(playerCode));
chkTrue(
  "HTML 里没有静态 <script src=...cloudbase...>（否则每人都要白下 965KB）",
  !/<script[^>]+src=["'][^"']*cloudbase[^"']*["']/i.test(playerRaw)
);
// 契约在接入云存档时变了：短路条件是**令牌**（凭证），不是 uid（标识，会出现在截图里）。
// 这条同时锁住「提前返回」和「返回前没有加载 SDK」—— 只断言有 return 是空闸。
const tokenShortcut = (() => {
  const start = playerCode.indexOf("if(stored.token)");
  if (start < 0) return "";
  const open = playerCode.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < playerCode.length; i++) {
    if (playerCode[i] === "{") depth++;
    else if (playerCode[i] === "}") { depth--; if (depth === 0) return playerCode.slice(open, i + 1); }
  }
  return "";
})();
chkTrue("已有令牌时提前返回，不加载 SDK",
  tokenShortcut.length > 0 && /return;/.test(tokenShortcut) && !/loadAccountSdk/.test(tokenShortcut),
  tokenShortcut.length ? "找到短路分支" : "没找到 if(stored.token) 分支");
chkTrue("推迟到空闲再建号（requestIdleCallback 或 setTimeout）", /requestIdleCallback/.test(playerCode) && /setTimeout/.test(playerCode));
chkTrue("失败只写 console，不 alert 打断玩家", !/\balert\s*\(/.test(playerCode));
chkTrue("建号失败被 catch 住，不会冒泡成未处理异常", /ensureAccount\(\)\s*\.catch\s*\(/.test(playerCode));
// ⚠️ 要断言"onerror 里重置了缓存"。只查 accountSdkPromise=null 是空闸 —— 顶部那句
//    `let accountSdkPromise = null;` 就满足了，删掉 onerror 里的重置也照样绿。
chkTrue(
  "SDK 加载失败会在 onerror 里重置缓存以便重试",
  /el\.onerror\s*=\s*\(\)\s*=>\s*\{[^}]*accountSdkPromise\s*=\s*null/.test(playerCode)
);

// ============================================================
console.log("\n--- 6. index.html：环境 ID 由服务端下发，前端不硬编码 ---");
// ============================================================
chkTrue("用签发响应里的 issued.env 初始化 SDK", /cloudbase\.init\(\s*\{\s*env\s*:\s*issued\.env/.test(playerCode));
chkTrue("签发响应缺 env 时明确报错", /缺少 ticket\/env/.test(playerCode));
chkTrue(
  "没有把环境 ID 硬编码进 init（换环境时最容易改漏一处，表现是静默登错环境）",
  !/cloudbase\.init\(\s*\{\s*env\s*:\s*["'][^"']+["']/.test(playerCode)
);

// ============================================================
console.log("\n--- 7. index.html：ACCOUNT_UID 声明必须早于所有 updateDevStatus() 调用（TDZ） ---");
// ============================================================
// 行号用**剥注释前**的文本算，避免块注释被删掉后行号错位。
const declMatch = playerRaw.match(/^\s*let\s+ACCOUNT_UID\s*=/m);
chkTrue("找到 let ACCOUNT_UID 声明", Boolean(declMatch));
const declLine = declMatch ? playerRaw.slice(0, declMatch.index).split("\n").length : Number.MAX_SAFE_INTEGER;
// 只算调用点：定义处是 `function updateDevStatus(){`，匹配 `updateDevStatus();` 不会误伤。
const callLines = [...playerRaw.matchAll(/updateDevStatus\(\);/g)].map(m => playerRaw.slice(0, m.index).split("\n").length);
chkTrue("找到 updateDevStatus() 的调用点", callLines.length >= 1, `${callLines.length} 处`);
const firstCall = callLines.length ? Math.min(...callLines) : Number.MAX_SAFE_INTEGER;
chkTrue(
  `ACCOUNT_UID 声明（第 ${declLine} 行）早于最早的 updateDevStatus() 调用（第 ${firstCall} 行）`,
  declLine < firstCall,
  "否则 let 的 TDZ 会抛 ReferenceError，整个页面白屏"
);
chkTrue(
  "updateDevStatus 里确实用到了 ACCOUNT_UID（否则这条断言是空的）",
  /账号：<b>\$\{ACCOUNT_UID/.test(playerCode)
);

// ============================================================
console.log("\n--- 8. account-check.html：自检页特有的容错 ---");
// ============================================================
chkTrue("URL 由 API_BASE 拼成两个常量（不再手写路径）", /HEALTH_URL\s*=/.test(checkCode) && /TICKET_URL\s*=/.test(checkCode));
chkTrue("只接 /health（不带 /api）", /HEALTH_URL\s*=\s*API_BASE\s*\+\s*["']\/health["']/.test(checkCode));
chkTrue("只接 /account/ticket（不带 /api）", /TICKET_URL\s*=\s*API_BASE\s*\+\s*["']\/account\/ticket["']/.test(checkCode));
chkTrue(
  "非 JSON 响应有兜底（部署期间网关返回 HTML，不能直接抛解析错误）",
  /looksLikeHtml/.test(checkCode) && /不是 JSON/.test(checkCode)
);
chkTrue("优先用签发响应里的 env，health 那份只做兜底", /if\s*\(d\.env\)\s*ENV_ID\s*=\s*d\.env/.test(checkCode));

// ============================================================
console.log("\n--- 9. 服务端契约：票据响应必须带 env ---");
// ============================================================
const server = stripComments(norm(fs.readFileSync(path.join(here, "..", "server.js"), "utf8")));
chkTrue("server.js 的签发响应里带 env", /env:\s*issued\.env/.test(server));

console.log("\n----");
console.log(`account-client.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
