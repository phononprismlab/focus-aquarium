// 「我的」抽屉资料卡的前端回归测试（静态锚 + 沙箱运行）。
//
// 后端那侧由 player-profile.test.js 覆盖（规则、白名单、限频）。
// 这里只盯前端接线，盯死三件事：
//   1) 昵称确实走 PUT /api/game/me（不是 POST、不是别的路径），且带 cloudHeaders()。
//   2) 保存失败时**不能**偷偷改本地已显示的昵称（否则界面显示的和库里不一致）。
//   3) 没登录（没令牌）时资料卡隐藏，不显示一片 0 的假数据。
// 末尾反向验证：把 method 换成 POST，确认断言会红。
//
// 运行：node test/player-profile-ui.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const playerPath = path.join(here, "..", "..", "index.html");
const raw = fs.readFileSync(playerPath, "utf8");
// 工作区是 CRLF，正则里的 \n 会匹配不上 —— 统一成 LF 再断言。
const playerRaw = raw.replace(/\r\n/g, "\n");
const playerCode = (playerRaw.match(/<script>([\s\S]*?)<\/script>/) || [null, playerRaw])[1];

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
}
function chkTrue(name, condition, detail = "") {
  const ok = condition === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` (${detail})` : ""}`);
  ok ? pass++ : fail++;
}
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  // ⚠️ indexOf("function X(") 会落在 "async function X(" 的中间，把 async 吃掉。
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

// ============================================================
console.log("--- 1. 静态结构：资料卡元素都在 ---");
// ============================================================
chkTrue("HTML 有资料卡 #mineProfile", /id="mineProfile"/.test(playerRaw));
chkTrue("资料卡默认隐藏（没登录不该显示一片 0）", /id="mineProfile"[^>]*\shidden/.test(playerRaw));
chkTrue("有昵称输入框 #mineNicknameInput", /id="mineNicknameInput"/.test(playerRaw));
chkTrue("输入框限制 12 字（与后端 NICKNAME_MAX_LENGTH 对齐）", /id="mineNicknameInput"[^>]*maxlength="12"/.test(playerRaw));
chkTrue("有保存按钮 #mineNicknameSave", /id="mineNicknameSave"/.test(playerRaw));
chkTrue("保存按钮默认禁用（没改动时不该可点）", /id="mineNicknameSave"[^>]*\sdisabled/.test(playerRaw));
chkTrue("有结果提示 #mineNicknameMsg", /id="mineNicknameMsg"/.test(playerRaw));
chkTrue("统计行：累计分钟 #mineFocusMinutes", /id="mineFocusMinutes"/.test(playerRaw));
chkTrue("统计行：累计次数 #mineFocusCount", /id="mineFocusCount"/.test(playerRaw));
chkTrue("统计行：今日分钟 #mineTodayMinutes", /id="mineTodayMinutes"/.test(playerRaw));
chkTrue("统计行：鱼数 #mineFishCount", /id="mineFishCount"/.test(playerRaw));
chkTrue("统计行：注册时间 #mineCreatedAt", /id="mineCreatedAt"/.test(playerRaw));
chkTrue("renderMineProfile 函数存在", /function renderMineProfile\(\)/.test(playerCode));
chkTrue("saveMineNickname 函数存在", /function saveMineNickname\(\)/.test(playerCode));

// ============================================================
console.log("\n--- 2. 静态：请求形状 ---");
// ============================================================
const saveSrc = extractFunction(playerCode, "saveMineNickname");
chkTrue("走 PUT（不是 POST）", /method:\s*"PUT"/.test(saveSrc));
chkTrue("打的是 /game/me（API_BASE 已含 /api，不能再写一次）", /`\$\{API_BASE\}\/game\/me`/.test(saveSrc));
chkTrue("带 cloudHeaders()（否则服务端拿不到 uid）", /cloudHeaders\(\)/.test(saveSrc));
chkTrue("body 只送 nickname", /JSON\.stringify\(\{\s*nickname:\s*value\s*\}\)/.test(saveSrc));
chkTrue("送之前 trim", /input\.value\.trim\(\)/.test(saveSrc));

const refreshSrc = extractFunction(playerCode, "refreshFocusStats");
chkTrue("refreshFocusStats 顺手存 nickname（不额外发一次请求）", /myProfile\.nickname\s*=\s*d\.nickname/.test(refreshSrc));
chkTrue("refreshFocusStats 顺手存 createdAt", /myProfile\.createdAt\s*=\s*Number\(d\.createdAt\)/.test(refreshSrc));

// ============================================================
console.log("\n--- 3. 运行时：保存成功 / 失败 / 网络异常 ---");
// ============================================================
function makeBox(fetchImpl) {
  const els = {
    mineNicknameInput: { value: "  阿鱼  " },
    mineNicknameMsg: { textContent: "", className: "" },
    mineNicknameSave: { disabled: false }
  };
  const code = [
    'const API_BASE = "https://api.test/api";',
    "let myProfile = { nickname: \"\", createdAt: 0 };",
    "const calls = [];",
    "function cloudHeaders(){ return { authorization: 'Bearer t' }; }",
    `const fetch = ${fetchImpl};`,
    "const document = { getElementById: id => __els[id] || null };",
    `const __els = ${JSON.stringify(els)};`,
    "__els.mineNicknameInput.value = '  阿鱼  ';",
    extractFunction(playerCode, "saveMineNickname"),
    "return { saveMineNickname, myProfile, els: __els, calls };"
  ].join("\n");
  return new Function(code)();
}

// 3.1 成功：写回 myProfile + 输入框 trim 后的值 + ok 提示
{
  const box = makeBox(`(url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { nickname: "阿鱼" } }) });
  }`);
  await box.saveMineNickname();
  chk("保存后 myProfile.nickname = 阿鱼", box.myProfile.nickname, "阿鱼");
  chk("保存后输入框被 trim 回写", box.els.mineNicknameInput.value, "阿鱼");
  chk("提示文案 = 昵称已保存", box.els.mineNicknameMsg.textContent, "昵称已保存");
  chk("提示用 ok 样式", box.els.mineNicknameMsg.className, "account-note ok");
  chk("请求方法 = PUT", box.calls[0].options.method, "PUT");
  chk("请求地址 = /game/me", box.calls[0].url, "https://api.test/api/game/me");
  chk("请求体 = {nickname:'阿鱼'}", JSON.parse(box.calls[0].options.body), { nickname: "阿鱼" });
}

// 3.2 服务端拒绝（400）：显示服务端理由，且**不能**改本地昵称
{
  const box = makeBox(`(url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "昵称最多 12 个字" }) });
  }`);
  await box.saveMineNickname();
  chk("失败时显示服务端理由", box.els.mineNicknameMsg.textContent, "昵称最多 12 个字");
  chk("失败用 bad 样式", box.els.mineNicknameMsg.className, "account-note bad");
  chk("失败时本地昵称保持原样（不被乐观更新）", box.myProfile.nickname, "");
}

// 3.3 限频 429：也走 bad 分支
{
  const box = makeBox(`(url, options) => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: "改得太频繁了，过一会儿再试" }) })`);
  await box.saveMineNickname();
  chk("429 时显示限频提示", box.els.mineNicknameMsg.textContent, "改得太频繁了，过一会儿再试");
  chk("429 也是 bad 样式", box.els.mineNicknameMsg.className, "account-note bad");
}

// 3.4 网络异常：不抛出去，只提示
{
  const box = makeBox(`() => Promise.reject(new Error("offline"))`);
  let threw = false;
  try { await box.saveMineNickname(); } catch { threw = true; }
  chk("网络异常不往外抛（主流程不能被挡）", threw, false);
  chk("网络异常提示 = 网络不太好，稍后再试", box.els.mineNicknameMsg.textContent, "网络不太好，稍后再试");
}

// 3.5 清空昵称：合法，提示换成「已清空」
{
  const box = makeBox(`(url, options) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { nickname: "" } }) })`);
  box.els.mineNicknameInput.value = "   ";
  await box.saveMineNickname();
  chk("清空后 myProfile.nickname = 空串", box.myProfile.nickname, "");
  chk("清空提示 = 昵称已清空", box.els.mineNicknameMsg.textContent, "昵称已清空");
}

// ============================================================
console.log("\n--- 4. 运行时：没登录时资料卡隐藏 ---");
// ============================================================
{
  const code = [
    "let CLOUD_SYNC_ENABLED = false;",
    "let ACCOUNT_TOKEN = \"\";",
    "let focusStats = { focusCount: 0, focusMinutesTotal: 0, focusCountToday: 0, focusMinutesToday: 0 };",
    "const AquariumData = { fish: [] };",
    "let myProfile = { nickname: \"\", createdAt: 0 };",
    "const __els = { mineProfile: { hidden: false } };",
    "const document = { getElementById: id => __els[id] || null, activeElement: null };",
    extractFunction(playerCode, "renderMineProfile"),
    "return { renderMineProfile, els: __els };"
  ].join("\n");
  const box = new Function(code)();
  box.renderMineProfile();
  chk("没令牌时资料卡 hidden = true", box.els.mineProfile.hidden, true);
}

{
  const code = [
    "let CLOUD_SYNC_ENABLED = true;",
    "let ACCOUNT_TOKEN = \"tok\";",
    "let focusStats = { focusCount: 12, focusMinutesTotal: 340, focusCountToday: 2, focusMinutesToday: 50 };",
    "const AquariumData = { fish: [{}, {}, {}] };",
    "let myProfile = { nickname: \"阿鱼\", createdAt: Date.UTC(2026, 8, 25) };",
    "const mk = () => ({ textContent: \"\", value: \"\", hidden: false, disabled: true });",
    "const __els = { mineProfile: mk(), mineNicknameInput: mk(), mineNicknameSave: mk(), mineFocusMinutes: mk(), mineFocusCount: mk(), mineTodayMinutes: mk(), mineFishCount: mk(), mineCreatedAt: mk() };",
    "const document = { getElementById: id => __els[id] || null, activeElement: null };",
    extractFunction(playerCode, "formatProfileDay"),
    extractFunction(playerCode, "renderMineProfile"),
    "return { renderMineProfile, els: __els };"
  ].join("\n");
  const box = new Function(code)();
  box.renderMineProfile();
  chk("登录后资料卡 hidden = false", box.els.mineProfile.hidden, false);
  chk("昵称回填到输入框", box.els.mineNicknameInput.value, "阿鱼");
  chk("累计分钟 = 340", box.els.mineFocusMinutes.textContent, "340");
  chk("累计次数 = 12", box.els.mineFocusCount.textContent, "12");
  chk("今日分钟 = 50", box.els.mineTodayMinutes.textContent, "50");
  chk("鱼数 = 3", box.els.mineFishCount.textContent, "3");
  chkTrue("注册时间渲染成日期", /来到水族馆\s2026-09-25/.test(box.els.mineCreatedAt.textContent));
  chk("昵称没改动时保存按钮禁用", box.els.mineNicknameSave.disabled, true);
}

// ============================================================
console.log("\n--- 5. 反向验证（破掉保护，断言必须变红）---");
// ============================================================
{
  const brokenMethod = saveSrc.replace('method: "PUT"', 'method: "POST"');
  chkTrue("反向：method 换成 POST 后断言会红（说明断言真的锚在 PUT 上）",
    /method:\s*"PUT"/.test(saveSrc) === true && /method:\s*"PUT"/.test(brokenMethod) === false);

  // 破坏「失败不改本地昵称」：改成乐观更新（先写 myProfile 再发请求）
  const box = makeBox(`(url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "坏了" }) });
  }`);
  await box.saveMineNickname();
  chkTrue("反向：失败路径没有乐观更新（myProfile.nickname 仍为空）", box.myProfile.nickname === "");

  // 破坏「没登录就隐藏」：把 hasCloud 恒为 true
  const code = [
    "let CLOUD_SYNC_ENABLED = false;",
    "let ACCOUNT_TOKEN = \"\";",
    "let focusStats = { focusCount: 0, focusMinutesTotal: 0, focusCountToday: 0, focusMinutesToday: 0 };",
    "const AquariumData = { fish: [] };",
    "let myProfile = { nickname: \"\", createdAt: 0 };",
    "const __els = { mineProfile: { hidden: false } };",
    "const document = { getElementById: id => __els[id] || null, activeElement: null };",
    extractFunction(playerCode, "renderMineProfile").replace("const hasCloud = Boolean(CLOUD_SYNC_ENABLED && ACCOUNT_TOKEN);", "const hasCloud = true;"),
    "return { renderMineProfile, els: __els };"
  ].join("\n");
  const broken = new Function(code)();
  broken.renderMineProfile();
  chkTrue("反向：把 hasCloud 写死成 true，资料卡就会露出来（说明这道闸真的在挡）",
    broken.els.mineProfile.hidden === false);
}

console.log(`\n===== 「我的」资料卡（前端）测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
