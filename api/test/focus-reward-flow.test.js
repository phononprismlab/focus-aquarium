// 回归测试：专注奖励的发放方式，以及商店预览图盖住占位 emoji。
//
// 两个真实踩过的坑：
// 1) 完成专注时先按本地值发泡泡、等服务端回来再"补正差额" —— 服务端按真实时长算出 0
//    时，玩家会眼睁睁看着"获得了 25 泡泡"被改成 0、泡泡又消失，像是被吞了奖励。
//    现在只有一个来源：服务端结算，本地值仅兜底；数字等结果回来一次性给出。
// 2) 商品预览图用绝对定位 + 不透明底色去盖 emoji 占位，但占位元素带 filter / position:relative，
//    会被提到"定位层"和图片同层，同层按 DOM 顺序绘制而占位写在图后面 → emoji 压在图上。
//    修法是给图一个正的 z-index，而不是依赖"绝对定位天然盖住静态内容"。
//
// 沿用项目约定：从 index.html 抽取真实源码到沙箱里跑，不手抄实现。
// 运行：node test/focus-reward-flow.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  if (ok) pass += 1;
  else fail += 1;
}
function chkTrue(name, actual) {
  const ok = actual === true;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}`);
  if (ok) pass += 1;
  else fail += 1;
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  // ⚠️ indexOf("function X(") 会落在 "async function X(" 的中间，把 async 吃掉，
  // 于是抽出来的 async 函数里 await 直接语法报错。这里把前缀补回去。
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

// ===== 1. applyFocusReward：唯一的落地点 =====
console.log("--- applyFocusReward：结算只做一次加法 ---");
const rewardBox = new Function(`
const PlayerData = { bubbles: 0 };
let saves = 0, renders = 0;
function saveGame(){ saves++; }
function renderBubbles(){ renders++; }
${extractFunction(source, "applyFocusReward")}
return {
  applyFocusReward,
  set: n => { PlayerData.bubbles = n; saves = 0; renders = 0; },
  state: () => ({ bubbles: PlayerData.bubbles, saves, renders })
};`)();

chk("发 25 泡泡", (() => { rewardBox.set(0); return [rewardBox.applyFocusReward(25), rewardBox.state()]; })(),
  [25, { bubbles: 25, saves: 1, renders: 1 }]);
chk("发 0 泡泡：不加、不存盘、不重绘（关键：不能先加再减）", (() => { rewardBox.set(100); return [rewardBox.applyFocusReward(0), rewardBox.state()]; })(),
  [0, { bubbles: 100, saves: 0, renders: 0 }]);
chk("负数当 0 处理", (() => { rewardBox.set(100); return [rewardBox.applyFocusReward(-30), rewardBox.state()]; })(),
  [0, { bubbles: 100, saves: 0, renders: 0 }]);
chk("NaN 当 0 处理", (() => { rewardBox.set(100); return [rewardBox.applyFocusReward(NaN), rewardBox.state()]; })(),
  [0, { bubbles: 100, saves: 0, renders: 0 }]);
chk("字符串数字也能吃", (() => { rewardBox.set(0); return [rewardBox.applyFocusReward("7"), rewardBox.state()]; })(),
  [7, { bubbles: 7, saves: 1, renders: 1 }]);
chk("小数向下取整", (() => { rewardBox.set(0); return [rewardBox.applyFocusReward(9.9), rewardBox.state()]; })(),
  [9, { bubbles: 9, saves: 1, renders: 1 }]);

// ===== 2. settleFocusReward：服务端优先、本地兜底 =====
console.log("\n--- settleFocusReward：服务端说了算，够不着才用本地值 ---");
function makeSettler(fetchImpl) {
  globalThis.__fetchImpl = fetchImpl;
  return new Function(`
let focusSessionId = null;
const API_BASE = "https://api.test/api";
// cloudHeaders 来自账号层：带上会话令牌，服务端才认人、才会把会话与结算写进 focus_records。
// 必须打桩 —— 少了它 settleFocusReward 会直接走进 catch，所有断言都退化成 local 兜底，
// 表面看像"服务端结算坏了"，实际只是沙箱缺依赖。
const cloudHeaders = () => ({ "Content-Type": "application/json", "Authorization": "Bearer test-token" });
const fetch = (url, options) => globalThis.__fetchImpl(url, options);
${extractFunction(source, "settleFocusReward")}
return {
  settleFocusReward,
  setSession: id => { focusSessionId = id; },
  getSession: () => focusSessionId
};`)();
}
const okBody = payload => async () => ({ ok: true, json: async () => payload });

// 有会话的结算：必须先登记 sessionId，否则函数会走"没有会话"的本地兜底分支。
async function settleWith(fetchImpl, localReward = 25, sessionId = "session-x") {
  const settler = makeSettler(fetchImpl);
  settler.setSession(sessionId);
  const result = await settler.settleFocusReward(localReward);
  return [result.reward, result.source];
}

chk("没有会话 → 本地兜底、且不发请求",
  await (() => { let called = 0; const s = makeSettler(async () => { called++; return { ok: true, json: async () => ({}) }; });
    return s.settleFocusReward(25).then(r => [r, called]); })(),
  [{ reward: 25, source: "local" }, 0]);
chk("服务端返回 30 → 用 30（不是本地 25）", await settleWith(okBody({ data: { reward: 30 } })), [30, "server"]);
chk("服务端返回 0 → 用 0（不是本地 25）", await settleWith(okBody({ data: { reward: 0 } })), [0, "server"]);
chk("服务端返回的奖励覆盖本地值", await settleWith(okBody({ data: { reward: 100 } }), 3), [100, "server"]);
chk("会话过期 404 → 本地兜底", await settleWith(async () => ({ ok: false, status: 404 })), [25, "local"]);
chk("网络异常 → 本地兜底", await settleWith(async () => { throw new Error("offline"); }), [25, "local"]);
chk("响应缺字段 → 本地兜底", await settleWith(okBody({})), [25, "local"]);
chk("奖励是负数 → 本地兜底（不接受扣分）", await settleWith(okBody({ data: { reward: -5 } })), [25, "local"]);
chk("奖励不是数字 → 本地兜底", await settleWith(okBody({ data: { reward: "abc" } })), [25, "local"]);

// 带令牌是这次接入的关键：没有它服务端不认人，focus_records 永远不落库（统计恒为 0）。
console.log("\n--- 专注请求必须带上会话令牌 ---");
chkTrue("结算请求用了 cloudHeaders()",
  /headers:\s*cloudHeaders\(\)/.test(extractFunction(source, "settleFocusReward")));
chkTrue("开始专注的请求也用了 cloudHeaders()",
  /headers:\s*cloudHeaders\(\)/.test(extractFunction(source, "beginServerFocusSession")));
chk("请求头里确实带上了 Authorization",
  await (async () => {
    let seen = null;
    const s = makeSettler(async (url, options) => {
      seen = (options && options.headers) || {};
      return { ok: true, json: async () => ({ data: { reward: 25 } }) };
    });
    s.setSession("session-h");
    await s.settleFocusReward(25);
    return seen && seen["Authorization"];
  })(),
  "Bearer test-token");

console.log("\n--- 防重放：会话只能用一次 ---");
{
  const s = makeSettler(okBody({ data: { reward: 25 } }));
  s.setSession("session-abc");
  await s.settleFocusReward(25);
  chk("结算后 sessionId 被清空", s.getSession(), null);
  const second = await s.settleFocusReward(25);
  chk("第二次只能用本地值（不会重复发奖）", [second.reward, second.source], [25, "local"]);
}

// ===== 3. resetFocus：不能再有"先发再收回" =====
console.log("\n--- resetFocus：数字只给一次，不做差额回滚 ---");
const resetFocusBody = extractFunction(source, "resetFocus");
chkTrue("不再先按本地值发泡泡", /PlayerData\.bubbles\s*\+=\s*localReward/.test(resetFocusBody) === false);
chkTrue("不再计算 delta 回滚", /const\s+delta\s*=/.test(resetFocusBody) === false);
chkTrue("不再出现 reward - localReward", /reward\s*-\s*localReward/.test(resetFocusBody) === false);
chkTrue("走 applyFocusReward 落地", /applyFocusReward\(/.test(resetFocusBody));
chkTrue("先显示「正在结算…」", /正在结算/.test(resetFocusBody));
chkTrue("0 泡泡时给出解释，不是干巴巴的 0", /没攒够时长/.test(resetFocusBody));

console.log("\n--- 本地兜底值仍然算得出来（离线可玩不能丢） ---");
chkTrue("保留本地兜底分钟数计算", /localReward\s*=\s*focusRewardMinutes\(/.test(resetFocusBody));
chkTrue("保留 completed / 提前结束两种口径", /completed\s*\?\s*Math\.floor\(durationSeconds\s*\/\s*60\)\s*:\s*elapsedMinutes/.test(resetFocusBody));

// ===== 4. 商店预览图必须压在占位之上 =====
console.log("\n--- 商店预览图：z-index 必须为正，不能靠层叠巧合 ---");
const imgRule = (source.match(/\.v02-preview-img\{[^}]*\}/) || [""])[0];
chkTrue("找到 .v02-preview-img 规则", imgRule.length > 0);
chkTrue("图带正的 z-index（否则 emoji 占位会压在图上）", /z-index:\s*[1-9]\d*/.test(imgRule));
chkTrue("仍然是 contain（不裁切）", /object-fit:contain/.test(imgRule));
chkTrue("仍然有不透明底色（有图时盖住占位）", /background:linear-gradient/.test(imgRule));
// 占位必须留在 DOM 里：图片 404 时靠它兜底，不能因为"有图就删占位"而让格子变空白
chkTrue("占位 emoji 仍渲染在 img 之后（DOM 顺序保留）",
  source.indexOf('class="v02-preview-fish"') > source.indexOf('class="v02-preview-img"'));
chkTrue("图片加载失败时移除自己，露出占位", /onerror="this\.remove\(\)"/.test(source));

// ===== 5. 商店图不能拖慢首屏 =====
// 商店是 display:none 的弹窗，但 display:none 里的 <img> 浏览器照样下载。
// 实测后台传一张 1000×1000 的预览图是 318KB，商品配满就是好几 MB 压在每次刷新上。
console.log("\n--- 商店预览图：商店没打开就不该下载 ---");
chkTrue("预览图带 loading=lazy", /class="v02-preview-img"[^>]*loading="lazy"/.test(source));
chkTrue("预览图带 decoding=async（不阻塞主线程解码）", /class="v02-preview-img"[^>]*decoding="async"/.test(source));

const adminSource = fs.readFileSync(path.join(here, "..", "..", "admin.html"), "utf8");
chkTrue("后台预览图上传处提示压缩尺寸", /建议先压到\s*400×400/.test(adminSource));

console.log("\n--- DEV 快进按钮要说明白：服务端按真实时间结算 ---");
chkTrue("DEV 面板写明快进不发泡泡", /快进.*不会发泡泡|不会发泡泡/.test(source));

console.log("\n----");
console.log(`focus-reward-flow.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
