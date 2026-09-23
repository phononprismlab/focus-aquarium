// 部署后线上冒烟：**只读**，不写任何数据、不碰后台写接口。
//
// 本机单测跑的是内存仓库，验证不了「真实云环境 + 真实配置数据」这一段。
// 这个脚本打的是线上地址，专门查那些**只有部署后才暴露**的问题：
//   · 存储引用有没有被解析成可用的签名链接（B13：漏了 fish 类型，鱼直接 404）
//   · 种子里还有没有历史死链（B15：previewImage 的假路径）
//   · 事件与资源之间的 tag 关联有没有断（断了不报错，只是永远不触发）
//   · 新版本有没有真的上线（/api/health 有没有 storageState / storageProblems）
//   · CORS 有没有配对（前后端不同域，配错前端全废）
//
// 用法（在 api 目录下）：
//   node test/smoke-live.mjs
//   node test/smoke-live.mjs --api https://xxx/api --web https://yyy
import { setTimeout as delay } from "node:timers/promises";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const API = argValue("--api", process.env.SMOKE_API || "https://focus-aquarium-api-316509-5-1491495221.sh.run.tcloudbase.com/api").replace(/\/$/, "");
const WEB = argValue("--web", process.env.SMOKE_WEB || "https://focus-aquarium-test-d0gpv0jya4925be19.webapps.tcloudbase.com").replace(/\/$/, "");
// /uploads 是挂在站点根上的（没有 /api 前缀），拼路径时要区分开。
const ORIGIN = API.replace(/\/api$/, "");
const TIMEOUT_MS = Number(argValue("--timeout", "15000"));

let pass = 0;
let fail = 0;
let warn = 0;
const failures = [];

function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : `  期望=${JSON.stringify(expected)}`}`);
  if (ok) pass += 1;
  else { fail += 1; failures.push(`${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`); }
}

function chkTrue(name, condition, detail = "") {
  const ok = Boolean(condition);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else { fail += 1; failures.push(`${name}${detail ? `（${detail}）` : ""}`); }
}

// 不算失败、但值得看一眼的情况（比如「种子鱼还没填 animationCode」属预期）。
function note(name, detail = "") {
  console.log(`WARN | ${name}${detail ? ` (${detail})` : ""}`);
  warn += 1;
}

async function get(path, headers = {}) {
  const started = Date.now();
  const res = await fetch(`${path.startsWith("http") ? "" : API}${path}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, headers: res.headers, body, text, ms: Date.now() - started };
}

async function post(path, bodyString, headers = {}) {
  const res = await fetch(`${path.startsWith("http") ? "" : API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bodyString,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, headers: res.headers, body, text };
}

// 配置里任何地方出现裸 tcbpg:// / cloud:// 都意味着「引用没被换成签名链接」，
// 玩家端会直接 404。递归找出来并报出具体路径，比只看有没有字符串更有用。
function findRawRefs(value, path = "") {
  const hits = [];
  const walk = (node, at) => {
    if (typeof node === "string") {
      if (node.includes("tcbpg://") || node.startsWith("cloud://")) hits.push(at || "(根)");
      return;
    }
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${at}[${index}]`));
    if (node && typeof node === "object") return Object.entries(node).forEach(([key, item]) => walk(item, at ? `${at}.${key}` : key));
  };
  walk(value, path);
  return hits;
}

console.log(`目标 API：${API}`);
console.log(`目标前端：${WEB}\n`);

// ---------- 1. 版本与存储自检 ----------
console.log("--- 1. 健康检查：新版本是否已上线 + 存储配置 ----------");
let health;
try {
  health = await get("/health");
} catch (error) {
  console.log(`FAIL | 连不上 /health：${error.message}`);
  console.log("\n如果报 SERVICE_FORBIDDEN / 连接被拒，是云托管平台层面的问题（服务被隔离或没起来），不是代码问题。");
  process.exit(1);
}
chk("健康检查状态码", health.status, 200);
console.log(`     响应耗时 ${health.ms}ms：${JSON.stringify(health.body)}`);
chkTrue("探针秒回（< 1500ms）", health.ms < 1500, `${health.ms}ms`);

const h = health.body || {};
chk("ok 字段", h.ok, true);
chk("存储驱动", h.storage, "cloudbase");
chk("存储模式（PG 才是本环境的正确通道）", h.storageMode, "pg");
chk("存储桶", h.storageBucket, "aquarium-assets");
chk("数据层状态", h.repository, "ok");
chk("管理鉴权已启用", h.adminAuth, "enabled");
chk("CORS 来自环境变量", h.cors, "configured");

// 新版本判别：这两个字段是今天加的，旧版本没有。
chkTrue("是新版本（有 storageState）", h.storageState && typeof h.storageState === "object", `storageState=${JSON.stringify(h.storageState)}`);
chkTrue("是新版本（有 storageProblems）", Array.isArray(h.storageProblems), `storageProblems=${JSON.stringify(h.storageProblems)}`);
chk("存储配置无问题", h.storageProblems, []);
if (h.storageState) {
  chkTrue("网关探测不是不可达", h.storageState.gateway !== "unreachable", `gateway=${h.storageState.gateway}`);
  if (h.storageState.upload === "failed") {
    note("最近一次真实上传失败过", `${h.storageState.lastErrorCode} ${h.storageState.lastError}`);
  } else if (h.storageState.upload === "unverified") {
    note("这一版还没人上传过文件", "storageState.upload=unverified 属正常，后台传一次就会变成 ok");
  }
}

// ---------- 2. 公开配置接口 ----------
console.log("\n--- 2. 公开配置接口（玩家端拿的就是这些） ---");
const types = ["decorations", "fish", "focus", "audio", "events"];
const payload = {};
for (const type of types) {
  const res = await get(`/game/${type}`);
  chk(`/game/${type} 状态码`, res.status, 200);
  const data = res.body && res.body.data;
  chkTrue(`/game/${type} 返回 data 数组`, Array.isArray(data), `长度=${Array.isArray(data) ? data.length : "非数组"}`);
  payload[type] = Array.isArray(data) ? data : [];
}
chkTrue("商品数量 ≥ 13（种子 13 件）", payload.decorations.length >= 13, `${payload.decorations.length} 件`);
chkTrue("鱼种数量 ≥ 2", payload.fish.length >= 2, `${payload.fish.length} 条`);
chkTrue("事件数量 ≥ 4（3 在线 + 1 离线）", payload.events.length >= 4, `${payload.events.length} 个`);

const focusRecord = payload.focus[0] && payload.focus[0].data;
chkTrue("专注配置含 minFocusDuration", focusRecord && Number.isFinite(Number(focusRecord.minFocusDuration)), `minFocusDuration=${focusRecord && focusRecord.minFocusDuration}`);
chkTrue("专注配置含 rewardTiers", focusRecord && Array.isArray(focusRecord.rewardTiers), `档数=${focusRecord && focusRecord.rewardTiers && focusRecord.rewardTiers.length}`);

// ---------- 3. 云存储引用必须已解析（B13 / B1）----------
console.log("\n--- 3. 云存储引用已解析成可用链接（B13：漏了 fish 就 404） ---");
for (const type of ["decorations", "fish", "audio"]) {
  const leaks = findRawRefs(payload[type]);
  chkTrue(`/game/${type} 没有未解析的云引用`, leaks.length === 0, leaks.slice(0, 5).join(", "));
}
const fishRaw = JSON.stringify(payload.fish);
chkTrue("鱼的 resourcePath 已是 https 链接或空", !/tcbpg:\/\//.test(fishRaw), "");
if (payload.fish.some(record => record.data && "animationCode" in record.data)) {
  chkTrue("鱼的动画代码已下发（总开关没被打开）", true, "");
} else {
  note("种子鱼还没填 animationCode", "属预期：后台填了才会出现；填错时玩家端会回退内置游法");
}

// ---------- 4. 历史死链与预览图（B15）----------
console.log("\n--- 4. 种子历史死链（B15） ---");
const LEGACY = /^assets\/[\w-]+\/[\w-]+_preview\.(webp|png|jpe?g|gif|avif)$/i;
const legacyPreviews = payload.decorations.filter(item => {
  const value = item.data && item.data.previewImage;
  return typeof value === "string" && LEGACY.test(value.trim());
});
chk("商品里没有历史假预览图路径", legacyPreviews.length, 0);

// ---------- 5. 事件与资源的 tag 关联 ----------
console.log("\n--- 5. 事件配置与 tag 关联（断了不报错，只是永远不触发） ---");
const HANDLERS = new Set(["give-bubbles", "treasure", "fish-escape"]);
const events = payload.events.map(record => record.data || {});
const badHandlers = events.filter(event => !HANDLERS.has(event.handler)).map(event => `${event.id}:${event.handler}`);
chk("所有事件的 handler 都在白名单里", badHandlers, []);

const allTags = new Set();
[...payload.decorations, ...payload.fish].forEach(record => {
  const tags = record.data && record.data.tags;
  const list = Array.isArray(tags) ? tags : (typeof tags === "string" ? [tags] : []);
  // 历史脏数据里有 tags: "" 的（F9 之前那个半成品输入框留下的），当空处理。
  list.forEach(tag => { const value = String(tag).trim().toLowerCase(); if (value) allTags.add(value); });
});
events.forEach(event => {
  if (event.relatedTag) {
    chkTrue(`事件「${event.id}」的 relatedTag 有资源挂着`, allTags.has(String(event.relatedTag).trim().toLowerCase()), `tag=${event.relatedTag}，现有 tag=${[...allTags].join(",") || "（空）"}`);
  }
  const conditionTag = event.conditions && event.conditions.hasTag;
  if (conditionTag) {
    chkTrue(`事件「${event.id}」的 hasTag 条件有资源挂着`, allTags.has(String(conditionTag).trim().toLowerCase()), `tag=${conditionTag}`);
  }
});

const BUBBLE_RANGE = new Set(["give-bubbles", "treasure"]);
events.forEach(event => {
  if (!BUBBLE_RANGE.has(event.handler)) return;
  const min = Number(event.params && event.params.min);
  const max = Number(event.params && event.params.max);
  chkTrue(`事件「${event.id}」泡泡区间合法（min≥1 且 max≥min）`, min >= 1 && max >= min, `min=${min} max=${max}`);
});

const offline = events.filter(event => event.eventType === "offline");
offline.forEach(event => {
  chkTrue(`离线事件「${event.id}」配了 maxOfflineHours`, Number(event.params && event.params.maxOfflineHours) >= 1, "");
});

chkTrue("每个事件都有 handler 和文案", events.every(event => event.handler && event.message), "");
// 事件改成配置驱动之后，文档原设计的两个「代码」字段不应该再存在。
chkTrue("事件里没有 eventCode / conditionCode 残留", events.every(event => !("eventCode" in event) && !("conditionCode" in event)), "");
chkTrue("鱼带 movementCode（回退用）", payload.fish.every(record => typeof (record.data && record.data.movementCode) === "string"), "");

// ---------- 6. CORS 配对（前后端不同域）----------
console.log("\n--- 6. CORS 配对 ---");
const corsRes = await get("/game/decorations", { Origin: WEB });
const allowOrigin = corsRes.headers.get("access-control-allow-origin");
chkTrue("前端域名被放行", allowOrigin === WEB || allowOrigin === "*", `access-control-allow-origin=${allowOrigin}`);
chkTrue("响应带 Vary: Origin（避免缓存串源）", String(corsRes.headers.get("vary") || "").toLowerCase().includes("origin"), `vary=${corsRes.headers.get("vary")}`);
const blocked = await get("/game/decorations", { Origin: "https://not-allowed.example.com" });
chk("陌生域名不发放 CORS 头", blocked.headers.get("access-control-allow-origin"), null);

// ---------- 7. 生产环境该关的关了、该拦的拦了 ----------
console.log("\n--- 7. 生产环境行为 ---");
const debug = await get("/debug/cloudbase-auth");
chk("生产环境没有 debug 接口", debug.status, 404);

for (const path of ["/admin/decorations", "/admin/events", "/admin/fish"]) {
  const res = await get(path);
  chk(`${path} 无密钥被拦`, res.status, 401);
}

const missingUpload = await get(`${ORIGIN}/uploads/__smoke_missing__.png`);
chk("缺失的 /uploads 文件返回 404", missingUpload.status, 404);
chkTrue("404 是 JSON 而不是 HTML（兜底错误处理保留了 4xx）", String(missingUpload.headers.get("content-type") || "").includes("application/json"), `content-type=${missingUpload.headers.get("content-type")}`);
chk("404 的错误文案", (missingUpload.body || {}).error, "资源不存在");

const unknown = await get("/game/__not_a_type__");
chk("未知配置类型 404", unknown.status, 404);

// express.json 注册在鉴权之前，所以这两个请求不带密钥也会被解析器先拦下来 ——
// 正好可以在生产环境上验证 B11 的兜底文案，而且请求本身是被拒绝的，不写任何数据。
console.log("\n--- 7b. 请求体兜底（B11，无需密钥：json 解析在鉴权之前） ---");
const tooBig = await post("/admin/decorations", JSON.stringify({ id: "x", category: "decor", name: "x".repeat(2_500_000) }));
chk("超过 2mb → 413", tooBig.status, 413);
chkTrue("413 是 JSON 不是 HTML", tooBig.body && typeof tooBig.body.error === "string", String((tooBig.body || {}).error || tooBig.text).slice(0, 70));
chkTrue("提示里指出该走上传接口", String((tooBig.body || {}).error || "").includes("/api/admin/assets/image"), "");
const brokenJson = await post("/admin/decorations", "{ this is not json ");
chk("JSON 语法错误 → 400", brokenJson.status, 400);
chkTrue("提示说明是 JSON 语法问题", String((brokenJson.body || {}).error || "").includes("合法 JSON"), "");

// ---------- 8. 前端静态站 ----------
console.log("\n--- 8. 前端静态站 ---");
for (const file of ["index.html", "admin.html", "config.js"]) {
  const res = await get(`${WEB}/${file}`);
  chk(`${file} 可访问`, res.status, 200);
}
const config = await get(`${WEB}/config.js`);
chkTrue("config.js 里的 API 地址与探测目标一致", config.text.includes(API.replace(/\/api$/, "")), "");
const adminHtml = await get(`${WEB}/admin.html`);
chkTrue("admin.html 含「事件设置」入口（新版本）", adminHtml.text.includes("事件设置"), "");
const indexHtml = await get(`${WEB}/index.html`);
chkTrue("index.html 含事件弹窗（新版本）", indexHtml.text.includes("eventModal") || indexHtml.text.includes("event-modal"), "");

// ---------- 汇总 ----------
console.log("\n----");
console.log(`线上冒烟：PASS=${pass} FAIL=${fail} WARN=${warn}`);
if (failures.length) {
  console.log("\n失败项：");
  failures.forEach(item => console.log(`  · ${item}`));
}
process.exit(fail > 0 ? 1 : 0);
