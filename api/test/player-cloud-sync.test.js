// 云存档「玩家端」接入的回归测试（index.html）。
// 服务端侧在 cloud-save.test.js；这里管的是玩家端：会话令牌、拉推存档、购买走服务端结算。
//
// 沿用项目约定：从 index.html 抽取真实源码到沙箱里跑，不手抄实现。
//   · 静态断言锁「结构」：必须用 cloudHeaders()、必须 PUT、必须 in-place 更新……
//   · 运行时断言锁「行为」：同步三分支、debounce 合并、409/402 的降级与提示。
//
// ⚠️ 别用「某标识符出现过」这种断言 —— 那是空闸（反向验证抓到过 2 次）。
//    要锚定「在什么结构里、做什么用」。

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

// 剥注释。⚠️ 不能用正则一把梭：注释正文里出现 `/api/game/*` 这类片段时，其中的
// `/*` 会被当成块注释起点，把后面大段代码一路吞掉。逐字符扫描，并跳过字符串字面量。
// 只删文本不删换行，所以行号不变（第 1 节要比较行号）。
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
        // 单双引号不能跨行；HTML 正文里的 don't / it's 就是靠这条不当成字符串起点。
        if (text[j] === "\n" && ch !== "`") { break; }
        j += 1;
      }
      if (j > i + 1 && text[j - 1] === ch) { out += text.slice(i, j); i = j; continue; }
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

const playerRaw = norm(source);
const playerCode = stripComments(playerRaw);

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  // indexOf("function X(") 会落在 "async function X(" 的中间，把 async 吃掉，
  // 抽出来的 async 函数里 await 就语法报错了 —— 把前缀补回去。
  const isAsync = src.slice(Math.max(0, start - 6), start) === "async ";
  const begin = isAsync ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(begin, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

const lineOf = (src, needle) => src.slice(0, src.indexOf(needle)).split("\n").length;

// ============================================================
console.log("--- 1. 账号层：令牌才是凭证 ---");
// ============================================================
chkTrue("建号成功后同时落盘 uid 与令牌",
  /localStorage\.setItem\(ACCOUNT_UID_KEY,uid\);\s*\n\s*localStorage\.setItem\(ACCOUNT_TOKEN_KEY,issued\.token\)/.test(playerCode));
chkTrue("短路条件用令牌而不是 uid",
  /if\(stored\.token\)\{/.test(playerCode));
chkTrue("读凭证的 helper 同时读 token 与 uid",
  /return \{ token, uid \};/.test(playerCode));
chkTrue("签发响应缺令牌时当失败处理（否则账号白建）",
  /签发响应缺少会话令牌/.test(playerCode));
// ensureAccount 的两条路径（有令牌短路 / 建号成功）都要打开云同步开关。
// ⚠️ 只数 ensureAccount 里的：兑换同步码也会开一次（见 sync-code.test.js），
//    按全文件计数会在加新入口时误报。
chk("ensureAccount 里 CLOUD_SYNC_ENABLED=true 出现次数（短路 + 建号）",
  (extractFunction(playerCode, "ensureAccount").match(/CLOUD_SYNC_ENABLED=true/g) || []).length, 2);
// 🔴 TDZ：saveGame() 在启动时（老存档补签名）就被同步调用，云同步状态声明晚了会白屏。
{
  // ⚠️ 锚点必须是 saveGame() 的**首次调用**（启动时给老存档补签名那两处），
  //    不是 scheduleCloudPush() 出现的位置 —— 后者在函数体里，只要声明在函数定义之前
  //    就满足，完全拦不住「声明被挪到调用之后」这个真正的白屏原因（反向验证抓到过）。
  const declLine = lineOf(playerCode, "let CLOUD_SYNC_ENABLED");
  const firstCallLine = lineOf(playerCode, "saveGame();");
  chkTrue("云同步状态声明早于 saveGame 的首次调用（TDZ）",
    declLine > 0 && firstCallLine > 0 && declLine < firstCallLine,
    `声明 L${declLine} < saveGame() 首次调用 L${firstCallLine}`);
}

// ============================================================
console.log("\n--- 2. 存档推送：PUT + debounce ---");
// ============================================================
const saveGameSrc = extractFunction(playerCode, "saveGame");
const persistSrc = extractFunction(playerCode, "persistLocalSave");
chkTrue("saveGame 里挂了云推送", /scheduleCloudPush\(\);/.test(saveGameSrc));
chkTrue("persistLocalSave 不触发推送（采用云端后落盘不该回推）",
  !/scheduleCloudPush/.test(persistSrc) && /localStorage\.setItem\(SAVE_KEY/.test(persistSrc));
chkTrue("推送用 PUT", /method:"PUT"/.test(extractFunction(playerCode, "pushCloudSave")));
chkTrue("推送路径是 /game/save", /\/game\/save/.test(extractFunction(playerCode, "pushCloudSave")));
chkTrue("debounce 会清掉上一次的定时器",
  /clearTimeout\(cloudPushTimer\)/.test(extractFunction(playerCode, "scheduleCloudPush")));
chkTrue("云同步没开时直接不推送（纯本地模式）",
  /if\(!CLOUD_SYNC_ENABLED\)\s*return;/.test(extractFunction(playerCode, "scheduleCloudPush")));
chkTrue("请求头统一走 cloudHeaders()",
  /headers:cloudHeaders\(\)/.test(extractFunction(playerCode, "pushCloudSave")));

// 运行时：debounce 真的把多次存档合并成一次推送。
{
  const box = (() => {
    const code = [
      'const API_BASE = "https://api.test/api";',
      "let ACCOUNT_TOKEN = \"tok\";",
      "let CLOUD_SYNC_ENABLED = true;",
      "let cloudPushTimer = 0;",
      "let pushes = 0;",
      "const timers = [];",
      "const setTimeout = (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; };",
      "const clearTimeout = id => { if (timers[id - 1]) timers[id - 1].cancelled = true; };",
      'const localStorage = { _d: {}, getItem(k){ return this._d[k] ?? null; }, setItem(k, v){ this._d[k] = String(v); } };',
      'const CLOUD_PUSHED_AT_KEY = "k";',
      'const SAVE_VERSION = "v1";',
      "const SaveData = { Settings: { audio: {} } };",
      "const PlayerData = { bubbles: 0 };",
      "const AquariumData = { fish: [] };",
      "let lastPushedAt = 0;",
      "function pushCloudSave(){ pushes++; return Promise.resolve(true); }",
      extractFunction(playerCode, "scheduleCloudPush"),
      "return { scheduleCloudPush, timers, count: () => pushes, fire: () => timers.forEach(t => { if (!t.cancelled) t.fn(); }) };"
    ].join("\n");
    return new Function(code)();
  })();
  box.scheduleCloudPush();
  box.scheduleCloudPush();
  box.scheduleCloudPush();
  chk("连续 3 次存档只登记 1 个定时器", box.timers.length, 3);
  chk("前 2 个定时器被取消", box.timers.slice(0, 2).map(t => t.cancelled), [true, true]);
  box.fire();
  chk("触发后只推送 1 次", box.count(), 1);
}

// ============================================================
console.log("\n--- 3. 启动同步：三分支 + in-place 更新 ---");
// ============================================================
chkTrue("applyCloudSave 走 replaceContents（就地写，不整体替换）",
  /replaceContents\(PlayerData,save\.PlayerData\)/.test(extractFunction(playerCode, "applyCloudSave")));
chkTrue("replaceContents 先清空再合并（保住对象引用）",
  /Object\.keys\(target\)\.forEach\(key=>\{ delete target\[key\]; \}\)/.test(extractFunction(playerCode, "replaceContents")));

// 运行时：replaceContents 必须保住引用 —— 整体替换会让所有闭包继续指向旧对象，
// 表现成「同步成功了但界面一点没变」。
{
  const box = (() => {
    const code = [
      extractFunction(playerCode, "replaceContents"),
      "return { replaceContents };"
    ].join("\n");
    return new Function(code)();
  })();
  const live = { bubbles: 1, isMember: false };
  const sameRef = live;
  box.replaceContents(live, { bubbles: 99 });
  chk("replaceContents 后引用不变", live === sameRef, true);
  chk("replaceContents 后内容已替换", live, { bubbles: 99 });
}

// 运行时：同步三分支。
function makeSyncBox(fetchImpl, { lastPushed = 0, enabled = true, token = "tok" } = {}) {
  // 桩函数只能通过 globalThis 递给沙箱：new Function 里是独立作用域，闭包变量进不去。
  globalThis.__syncFetchImpl = fetchImpl;
  const code = [
    'const API_BASE = "https://api.test/api";',
    `let ACCOUNT_TOKEN = ${JSON.stringify(token)};`,
    `let CLOUD_SYNC_ENABLED = ${enabled};`,
    `let lastPushedAt = ${lastPushed};`,
    "let cloudPushTimer = 0;",
    "let renders = 0, persists = 0, pushes = 0;",
    "const console = { warn(){}, info(){}, log(){} };",
    'const localStorage = { _d: {}, getItem(k){ return this._d[k] ?? null; }, setItem(k, v){ this._d[k] = String(v); } };',
    'const CLOUD_PUSHED_AT_KEY = "k";',
    'const SAVE_VERSION = "v1";',
    "const SaveData = { Settings: { audio: { master: 50 } } };",
    'const PlayerData = { bubbles: 10, isMember: false, inventory: { fish: {}, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } };',
    'const AquariumData = { fish: [], decoration: "", background: "", sand: "", ambientSound: "" };',
    "function ensureInventory(){}",
    "function renderBubbles(){ renders++; }",
    "function renderAquarium(){ renders++; }",
    "function persistLocalSave(){ persists++; }",
    "let fetchImpl = globalThis.__syncFetchImpl;",
    "const fetch = (url, options) => fetchImpl(url, options);",
    extractFunction(playerCode, "cloudHeaders"),
    extractFunction(playerCode, "buildCloudPayload"),
    extractFunction(playerCode, "replaceContents"),
    extractFunction(playerCode, "applyCloudSave"),
    extractFunction(playerCode, "markPushed"),
    extractFunction(playerCode, "pushCloudSave"),
    extractFunction(playerCode, "syncCloudSave"),
    "return {",
    "  syncCloudSave, pushCloudSave, buildCloudPayload, cloudHeaders,",
    "  setFetch: fn => { fetchImpl = fn; },",
    "  state: () => ({ PlayerData, AquariumData, SaveData, lastPushedAt, renders, persists, pushes })",
    "};"
  ].join("\n");
  return new Function(code)();
}

// ① 云端没有存档 → 把本地推上去（老玩家的本地进度不能丢）
{
  const box = makeSyncBox(async (url, options) => {
    if (options && options.method === "PUT") return { ok: true, json: async () => ({ data: { updatedAt: 777 } }) };
    return { ok: true, json: async () => ({ data: { exists: false, save: null, updatedAt: 0 } }) };
  });
  await box.syncCloudSave();
  chk("① 云端无存档 → 本地推上去（updatedAt 被记下）", box.state().lastPushedAt, 777);
}
// ② 云端比本地新 → 采用云端（就地写进 PlayerData / AquariumData）
{
  const remote = {
    PlayerData: { bubbles: 500, isMember: false, inventory: { fish: { fish001: 2 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
    AquariumData: { fish: [{ itemId: "fish001" }], decoration: "", background: "", sand: "", ambientSound: "" },
    Settings: { audio: { master: 30 } }
  };
  const box = makeSyncBox(async (url, options) => {
    if (options && options.method === "PUT") return { ok: true, json: async () => ({ data: { updatedAt: 999 } }) };
    return { ok: true, json: async () => ({ data: { exists: true, save: remote, updatedAt: 900 } }) };
  }, { lastPushed: 100 });
  await box.syncCloudSave();
  const s = box.state();
  chk("② 采用云端的泡泡", s.PlayerData.bubbles, 500);
  chk("② 采用云端的鱼缸", s.AquariumData.fish, [{ itemId: "fish001" }]);
  chk("② 采用云端的音量设置", s.SaveData.Settings.audio.master, 30);
  chk("② 采用云端后重绘了一次", s.renders, 2);
  chk("② 采用云端后不回推（只落盘一次）", s.persists, 1);
  chk("② 记下云端的 updatedAt", s.lastPushedAt, 900);
}
// ③ 本地有未推送的改动（离线玩过）→ 推本地上去，不能被云端覆盖
{
  const box = makeSyncBox(async (url, options) => {
    if (options && options.method === "PUT") return { ok: true, json: async () => ({ data: { updatedAt: 1234 } }) };
    return { ok: true, json: async () => ({ data: { exists: true, save: { PlayerData: { bubbles: 1 } }, updatedAt: 500 } }) };
  }, { lastPushed: 800 });
  await box.syncCloudSave();
  chk("③ 本地更新 → 推本地（云端泡泡没被采用）", box.state().PlayerData.bubbles, 10);
  chk("③ 推送后记下新的 updatedAt", box.state().lastPushedAt, 1234);
}
// ④ 请求失败 → 静默兜底，不能把主流程带崩
{
  const box = makeSyncBox(async () => { throw new Error("offline"); });
  let threw = false;
  try { await box.syncCloudSave(); } catch (_) { threw = true; }
  chk("④ 同步失败不抛异常（离线可用）", threw, false);
}

// ============================================================
console.log("\n--- 4. 购买：服务端结算优先，本地兜底 ---");
// ============================================================
const onServerSrc = extractFunction(playerCode, "saveAquariumOnServer");
chkTrue("结算走 /game/shop/settle", /\/game\/shop\/settle/.test(onServerSrc));
chkTrue("结算提交目标鱼缸（TempAquariumData）", /JSON\.stringify\(TempAquariumData\)/.test(onServerSrc));
chkTrue("收据用服务端返回的 rows", /payload\.rows/.test(onServerSrc));
chkTrue("409/401/503 判定为「暂时用不了」→ 返回 false 让调用方降级",
  /response\.status===409\|\|response\.status===401\|\|response\.status===503/.test(onServerSrc));
chkTrue("402 是泡泡不够（单独文案）", /response\.status===402/.test(onServerSrc));
chkTrue("结算成功后重绘并关闭商店", /renderBubbles\(\)[\s\S]{0,80}closeShop\(true\)/.test(onServerSrc));
{
  const aquariumSrc = extractFunction(playerCode, "saveAquarium");
  chkTrue("saveAquarium 先试服务端，失败才走本地",
    /if\(CLOUD_SYNC_ENABLED && await saveAquariumOnServer\(\)\) return;/.test(aquariumSrc));
  chkTrue("本地兜底逻辑仍在（降级不是死路）", /buildSettlement\(TempAquariumData\)/.test(aquariumSrc));
}

// 运行时：结算接口的三种回应。
function makeSettleBox(fetchImpl) {
  globalThis.__settleFetchImpl = fetchImpl;
  const code = [
    'const API_BASE = "https://api.test/api";',
    'let ACCOUNT_TOKEN = "tok";',
    "const console = { warn(){}, info(){}, log(){} };",
    'const TempAquariumData = { fish: [{ itemId: "fish002" }] };',
    'const PlayerData = { bubbles: 40, inventory: {} };',
    'const AquariumData = { fish: [] };',
    "let applied = 0, receipts = [], closed = 0, persisted = 0, marked = 0, audio = 0;",
    "function cloudHeaders(){ return { \"Content-Type\": \"application/json\" }; }",
    "function applyCloudSave(){ applied++; return true; }",
    "function persistLocalSave(){ persisted++; }",
    "function renderBubbles(){}",
    "function renderAquarium(){}",
    "function closeShop(){ closed++; }",
    "function syncAmbientAudio(){ audio++; }",
    "function markPushed(){ marked++; }",
    "function buildSettlement(){ return { rows: [{ name: \"本地行\", qty: 1, price: 0 }] }; }",
    "function showPurchaseReceipt(title, rows, paid, note, options){ receipts.push({ title, rows, paid, note, options }); }",
    "let fetchImpl = globalThis.__settleFetchImpl;",
    "const fetch = (url, options) => fetchImpl(url, options);",
    extractFunction(playerCode, "saveAquariumOnServer"),
    "return { saveAquariumOnServer, receipts, state: () => ({ applied, persisted, closed, marked, audio }), setFetch: fn => { fetchImpl = fn; } };"
  ].join("\n");
  return new Function(code)();
}

// 成功：应用服务端存档 + 用服务端 rows 出收据
{
  const serverRows = [{ itemId: "fish002", name: "蓝尾鱼", qty: 1, price: 35 }];
  const box = makeSettleBox(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { save: { PlayerData: {} }, paid: 35, refund: 0, total: 35, balance: 65, rows: serverRows } })
  }));
  const handled = await box.saveAquariumOnServer();
  chk("结算成功 → 已处理", handled, true);
  chk("用了服务端返回的 rows（不是本地那份）", box.receipts[0].rows, serverRows);
  chk("收据金额来自服务端", box.receipts[0].paid, 35);
  chk("应用了服务端存档", box.state().applied, 1);
  chk("关闭了商店", box.state().closed, 1);
}
// 402：泡泡不够 → 提示「还差」，且不降级（否则本地会重复算一遍）
{
  const box = makeSettleBox(async () => ({
    ok: false,
    status: 402,
    json: async () => ({ error: "泡泡不足", code: "INSUFFICIENT", short: 30, paid: 70, refund: 0 })
  }));
  const handled = await box.saveAquariumOnServer();
  chk("402 → 已处理（不降级）", handled, true);
  chk("402 → 收据标题是「无法保存」", box.receipts[0].title, "无法保存");
  chkTrue("402 → 文案说清了还差多少", /泡泡不足/.test(box.receipts[0].note), box.receipts[0].note);
  chk("402 → 没有应用任何存档", box.state().applied, 0);
}
// 409：云端还没有存档 → 返回 false，交给本地逻辑
{
  const box = makeSettleBox(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "还没有云存档" })
  }));
  chk("409 → 返回 false（降级到本地）", await box.saveAquariumOnServer(), false);
  chk("409 → 不出收据", box.receipts.length, 0);
}
// 网络异常：同样降级，不能把玩家卡在商店里
{
  const box = makeSettleBox(async () => { throw new Error("offline"); });
  chk("网络异常 → 返回 false（降级到本地）", await box.saveAquariumOnServer(), false);
}

// ============================================================
console.log("\n--- 5. 降级与总开关 ---");
// ============================================================
chkTrue("FISHTANK_DISABLE_ACCOUNT 时不建号（云同步自然保持关闭）",
  /if\(window\.FISHTANK_DISABLE_ACCOUNT\) return;/.test(extractFunction(playerCode, "ensureAccount")));
chkTrue("云同步默认关闭（声明处初始值 false）",
  /let CLOUD_SYNC_ENABLED = false;/.test(playerCode));
{
  const box = makeSyncBox(async () => { throw new Error("should not be called"); }, { enabled: false });
  let called = 0;
  box.setFetch(async () => { called++; return { ok: true, json: async () => ({ data: {} }) }; });
  await box.syncCloudSave();
  chk("云同步关闭时一次请求都不发", called, 0);
}
chkTrue("DEV 面板显示云同步状态", /云同步：<b>\$\{CLOUD_SYNC_ENABLED/.test(playerRaw));
// saveAquarium 变成 async 之后，它直接挂在 click 上：事件处理器不接管返回的 Promise，
// 必须自己 catch，否则任何异常都会变成 unhandledrejection 后静默消失。
{
  const anchor = 'getElementById("shopSaveBtn")';
  const idx = playerCode.indexOf(anchor);
  const block = idx < 0 ? "" : playerCode.slice(idx, idx + 320);
  chkTrue("商店保存按钮兜住了 saveAquarium 的 Promise（不产生 unhandledrejection）",
    idx >= 0 && /addEventListener\("click"/.test(block) && /saveAquarium\(\)\s*\.catch\(/.test(block),
    idx < 0 ? "找不到 shopSaveBtn 绑定" : block.replace(/\s+/g, " ").slice(0, 130));
}

console.log(`\n----\nplayer-cloud-sync.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
