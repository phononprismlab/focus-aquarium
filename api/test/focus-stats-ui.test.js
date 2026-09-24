// 专注聚合统计「前端」回归测试（index.html）。
//
// 盯的是：前端只消费 GET /api/game/me 的四个聚合字段，绝不请求/渲染逐条明细；
// 状态条在账号就绪后拉一次、每次专注结算后再拉一次；展示文案正确。
//
// 沿用项目约定：从 index.html 抽真实源码到沙箱里跑，不手抄实现。
// 反向验证：服务端即便把明细塞进响应，前端也只取聚合字段、绝不落进 focusStats。
//
// 运行：node test/focus-stats-ui.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const source = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}
function chkTrue(name, actual, detail = "") {
  const ok = actual === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}

const norm = text => text.replace(/\r\n/g, "\n");
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
        if (text[j] === "\n" && ch !== "`") break;
        j += 1;
      }
      if (j > i + 1 && text[j - 1] === ch) { out += text.slice(i, j); i = j; continue; }
      out += ch; i += 1; continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop; continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop; continue;
    }
    out += ch; i += 1;
  }
  return out;
}
const playerRaw = norm(source);
const playerCode = stripComments(playerRaw);

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  const isAsync = src.slice(Math.max(0, start - 6), start) === "async ";
  const begin = isAsync ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(begin, i + 1); }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

// ============================================================
console.log("--- 1. 静态结构：状态条元素 + 函数都在 ---");
// ============================================================
chkTrue("HTML 有专注状态条容器 #focusStatus", /id="focusStatus"/.test(playerRaw));
chkTrue("状态条有 #focusToday（今日）", /id="focusToday"/.test(playerRaw));
chkTrue("状态条有 #focusTotal（累计）", /id="focusTotal"/.test(playerRaw));
chkTrue("状态条默认隐藏（没账号时不展示）", /id="focusStatus"[^>]*\shidden/.test(playerRaw));
chkTrue("renderFocusStats 函数存在", /function renderFocusStats\(\)/.test(playerCode));
chkTrue("refreshFocusStats 函数存在", /async function refreshFocusStats\(\)/.test(playerCode));

const refreshSrc = extractFunction(playerCode, "refreshFocusStats");
chkTrue("refreshFocusStats 只拉 /api/game/me（不新增明细接口）", /\/game\/me/.test(refreshSrc));
chkTrue("refreshFocusStats 请求头走 cloudHeaders()", /headers:\s*cloudHeaders\(\)/.test(refreshSrc));
chkTrue("refreshFocusStats 用 GET", /method:\s*"GET"/.test(refreshSrc));
chkTrue("没令牌时直接跳过（不白跑一趟）", /if\(!CLOUD_SYNC_ENABLED\s*\|\|\s*!ACCOUNT_TOKEN\)\s*return;/.test(refreshSrc));
chkTrue("只取四个聚合字段，无逐条明细引用", !/records|history|detail|明细/.test(refreshSrc));

const renderSrc = extractFunction(playerCode, "renderFocusStats");
chkTrue("renderFocusStats 把今日写入 #focusToday", /getElementById\("focusToday"\)/.test(renderSrc));
chkTrue("renderFocusStats 把累计写入 #focusTotal", /getElementById\("focusTotal"\)/.test(renderSrc));
chkTrue("renderFocusStats 没账号时隐藏状态条", /el\.hidden\s*=\s*true/.test(renderSrc));

// 调用时机：账号就绪 + 每次专注结算后都要拉一次。
chkTrue("ensureAccount（有令牌分支）结算后刷新统计", /syncCloudSave\(\);\s*\n\s*refreshFocusStats\(\);/.test(extractFunction(playerCode, "ensureAccount")));
chkTrue("专注结算完成后刷新统计", /settleFocusReward\(localReward\)\.then\([\s\S]{0,200}refreshFocusStats\(\)/.test(extractFunction(playerCode, "resetFocus")));
chkTrue("兑换同步码接管后刷新统计", /await syncCloudSave\(\);\s*\n\s*refreshFocusStats\(\);/.test(extractFunction(playerCode, "redeemSyncCode")));

// ============================================================
console.log("\n--- 2. 运行时：拉取 / 渲染 / 无令牌不请求 ---");
// ============================================================
function makeStatsBox(fetchImpl, { enabled = true, token = "tok" } = {}) {
  globalThis.__statsFetchImpl = fetchImpl;
  const code = [
    'const API_BASE = "https://api.test/api";',
    `let ACCOUNT_TOKEN = ${JSON.stringify(token)};`,
    `let CLOUD_SYNC_ENABLED = ${enabled};`,
    "let focusStats = { focusCount:0, focusMinutesTotal:0, focusCountToday:0, focusMinutesToday:0 };",
    "let fetchCalls = [];",
    "const console = { warn(){}, info(){}, log(){} };",
    "const __els = { focusStatus: { hidden: true, textContent: \"\" }, focusToday: { textContent: \"\" }, focusTotal: { textContent: \"\" } };",
    "const document = { getElementById: id => __els[id] || null };",
    "let fetchImpl = globalThis.__statsFetchImpl;",
    "const fetch = (url, options) => { fetchCalls.push({ url, options }); return fetchImpl(url, options); };",
    extractFunction(playerCode, "cloudHeaders"),
    extractFunction(playerCode, "renderFocusStats"),
    extractFunction(playerCode, "refreshFocusStats"),
    "return { refreshFocusStats, getStats: () => focusStats, getEls: () => __els, calls: () => fetchCalls };"
  ].join("\n");
  return new Function(code)();
}

// 2.1 无令牌：守卫拦住，不发出任何请求
{
  const box = makeStatsBox(async () => ({ ok: true, json: async () => ({ data: {} }) }), { enabled: false, token: "" });
  await box.refreshFocusStats();
  chk("无令牌时 refreshFocusStats 不发请求", box.calls().length, 0);
}

// 2.2 正常：拉到聚合字段并渲染
{
  const box = makeStatsBox(async () => ({
    ok: true,
    json: async () => ({ data: { focusCount: 3, focusMinutesTotal: 120, focusCountToday: 1, focusMinutesToday: 25 } })
  }));
  await box.refreshFocusStats();
  const calls = box.calls();
  chk("发起了一次请求", calls.length, 1);
  chkTrue("请求打到 /game/me", calls[0].url.includes("/game/me"));
  chkTrue("请求带 Bearer 令牌", (calls[0].options?.headers?.Authorization || "").startsWith("Bearer "));
  const s = box.getStats();
  chk("focusStats.focusCount 已更新", s.focusCount, 3);
  chk("focusStats.focusMinutesTotal 已更新", s.focusMinutesTotal, 120);
  chk("focusStats.focusCountToday 已更新", s.focusCountToday, 1);
  chk("focusStats.focusMinutesToday 已更新", s.focusMinutesToday, 25);
  const els = box.getEls();
  chkTrue("状态条可见（hidden=false）", els.focusStatus.hidden === false);
  chkTrue("今日文案含次数", els.focusToday.textContent.includes("1"));
  chkTrue("今日文案含分钟", els.focusToday.textContent.includes("25"));
  chkTrue("累计文案含次数", els.focusTotal.textContent.includes("3"));
  chkTrue("累计文案含分钟", els.focusTotal.textContent.includes("120"));
}

// ============================================================
console.log("\n--- 3. 反向验证：服务端塞明细，前端只取聚合 ---");
// ============================================================
{
  // 服务端（哪怕被写成）把逐条明细也塞进响应：前端必须无视。
  const box = makeStatsBox(async () => ({
    ok: true,
    json: async () => ({
      data: {
        focusCount: 3,
        focusMinutesTotal: 120,
        focusCountToday: 1,
        focusMinutesToday: 25,
        records: [{ id: "r1", counted_minutes: 25 }, { id: "r2", counted_minutes: 40 }], // 明细
        history: [{ at: 1 }, { at: 2 }],
        detail: "逐条明细"
      }
    })
  }));
  await box.refreshFocusStats();
  const s = box.getStats();
  const keys = Object.keys(s).sort();
  chk("focusStats 只有四个聚合字段（明细没漏进来）", keys, ["focusCount", "focusCountToday", "focusMinutesToday", "focusMinutesTotal"].sort());
  chk("明细字段从未进 focusStats", ("records" in s) || ("history" in s) || ("detail" in s), false);
  const els = box.getEls();
  chkTrue("今日文案没被明细污染", !els.focusToday.textContent.includes("逐条") && !els.focusToday.textContent.includes("history"));
}

console.log(`\n===== 专注聚合统计（前端）测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
