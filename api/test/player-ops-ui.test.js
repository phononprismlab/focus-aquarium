// 玩家端「运营配置」回归测试（index.html）：停机维护页 + 顶栏公告。
// 后端闸门在 ops-config.test.js；这里管的是玩家看到的那半边。
//
// 沿用项目约定：从 index.html 抽真实源码到沙箱里跑，不手抄实现。
//   · 静态断言锁「结构」：维护页层级、图标位置、CTA 只放行 http(s)、失败开放……
//   · 运行时断言锁「行为」：公告有效期、已读裁剪、节流、503 闸门识别。
//
// ⚠️ 别用「某标识符出现过」这种断言 —— 那是空闸（反向验证抓到过 2 次）。
//    要锚定「在什么结构里、做什么用」。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const source = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
const adminSource = fs.readFileSync(path.join(repoRoot, "admin.html"), "utf8");

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

// 剥注释（与 player-cloud-sync 同一份实现）。⚠️ 不能用正则一把梭：注释正文里的
// `/api/game/*` 会被当成块注释起点，把后面大段代码吞掉。逐字符扫描并跳过字符串。
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
  // indexOf("function X(") 会落在 "async function X(" 中间，把 async 吃掉 —— 补回去。
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
console.log("--- 1. 维护页：层级与默认态 ---");
// ============================================================
{
  // 默认必须是隐藏的：页面不该一上来就盖一层维护页。
  chkTrue("维护页默认 hidden",
    /<div class="fa-maintenance" id="maintenanceScreen" hidden/.test(playerRaw));

  const z = Number((((playerRaw.match(/\.fa-maintenance\{[^}]*\}/) || [""])[0]).match(/z-index:(\d+)/) || [])[1]);
  chkTrue("维护页 z-index 解析成功", Number.isFinite(z) && z > 0, `=${z}`);
  // 抽屉是 2000。维护页压不住抽屉的后果是：玩家能从维护页边上点开商店，
  // 装点半天再被 503 打回来 —— 这是停机功能最常见也最糟糕的漏洞。
  chkTrue("维护页在抽屉(2000)之上", z > 2000);
  chkTrue("hidden 时真的不显示", /\.fa-maintenance\[hidden\]\{display:none/.test(playerRaw));
  chkTrue("维护中关掉底层交互（键盘 Tab 也不该操作到鱼缸）",
    /body\.fa-maintenance-on \.app\{pointer-events:none/.test(playerRaw));

  // 维护页一开，浮在它上面的抽屉／弹窗必须先收掉，否则玩家看得到却点不动。
  const showSrc = extractFunction(playerCode, "showMaintenance");
  chkTrue("开维护页时收掉可能浮在上面的层",
    /\["infoModal","noticeModal","modal","shopModal","mineDrawer","settingsDrawer"\]\.forEach\(id => \{[\s\S]{0,160}classList\.remove\("show"\)/.test(showSrc));
  chkTrue("维护页带 body 标记（CSS 靠它关交互）",
    /document\.body\.classList\.add\("fa-maintenance-on"\)/.test(showSrc));
  chkTrue("关维护页时撤掉 body 标记",
    /classList\.remove\("fa-maintenance-on"\)/.test(extractFunction(playerCode, "hideMaintenance")));
  chkTrue("文案与预计恢复都能显示",
    /messageEl\.textContent = message;/.test(showSrc) && /etaEl\.hidden = !eta;/.test(showSrc));
}

// ============================================================
console.log("\n--- 2. 公告图标：位置与隐藏 ---");
// ============================================================
{
  // 图标必须紧挨标题右侧（顶栏左组），而不是混进右边那三个入口里 ——
  // 那三个是「抽屉开关」，公告是「一次性信息」，语义不同，位置和外观都要分开。
  chkTrue("公告图标紧跟标题之后",
    /<h1 class="v02-brand-title" id="appTitle">[^<]*<\/h1>\s*\n\s*<button type="button" class="v02-notice-btn" id="opsNoticeBtn" hidden/.test(playerRaw));
  chkTrue("hidden 时真的不显示（默认 display:none）",
    /\.v02-notice-btn\{[^}]*display:none/.test(playerRaw));
  chkTrue("非 hidden 才显示（:not([hidden]) 才 inline-flex）",
    /\.v02-notice-btn:not\(\[hidden\]\)\{display:inline-flex/.test(playerRaw));

  const renderSrc = extractFunction(playerCode, "renderOpsNotice");
  chkTrue("没有有效公告时图标隐藏", /opsNoticeBtn\.hidden = !notice;/.test(renderSrc));
  // 级别字符串必须和后台「运营」页那两个选项对得上，写错了颜色就永远不生效。
  chkTrue("级别 class 有独立配色（公告不是都一样重要）",
    /level-\$\{level\}/.test(renderSrc) && /\.v02-notice-btn\.level-warning\{/.test(playerRaw));
  chkTrue("级别取值与后台一致（info / warning）",
    adminSource.includes('<option value="info"') && adminSource.includes('<option value="warning"'));
}

// ============================================================
console.log("\n--- 3. 失败开放：拉不到配置 = 不停机 ---");
// ============================================================
{
  const fetchSrc = extractFunction(playerCode, "fetchOpsConfig");
  chkTrue("拉配置整段 try/catch（网络挂了不能把页面带崩）",
    /async function fetchOpsConfig\(\)\{\s*try\{/.test(fetchSrc));
  chkTrue("失败返回 null（由调用方按没配处理）", /catch\(_\)\{ return null; \}/.test(fetchSrc));
  chkTrue("有超时（接口挂住不能让首屏一直等）",
    /setTimeout\(\(\) => controller\.abort\(\), 8000\)/.test(fetchSrc));
  chkTrue("只认已发布配置的 ops 记录", /entry\.id === "ops"/.test(fetchSrc));

  const refreshSrc = extractFunction(playerCode, "refreshOps");
  // 「maintenance === true」必须严格比较：后台存进来的是 JSON，但如果哪天字段被写成
  // 字符串 "true"，宽松判断会把全站误判成停机 —— 那是比停机本身严重得多的事故。
  chkTrue("停机判定用严格 === true", /if\(ops\.maintenance === true\)/.test(refreshSrc));
  chkTrue("配置为空时按没配处理（OPS_CONFIG || {}）", /const ops = OPS_CONFIG \|\| \{\};/.test(refreshSrc));
}

// 运行时：三种配置来源各自的结果
{
  const recheckLine = (playerCode.match(/const OPS_RECHECK_MS = \d+;/) || [""])[0];
  chkTrue("重查节流阈值已声明", /const OPS_RECHECK_MS = \d+;/.test(recheckLine), recheckLine);
  const box = (() => {
    const code = [
      recheckLine,
      "let lastOpsCheckAt = 0;",
      "let OPS_CONFIG = null;",
      "let pendingNotice = null;",
      "let shown = 0, hidden = 0, fetches = 0;",
      "function showMaintenance(){ shown++; }",
      "function hideMaintenance(){ hidden++; }",
      "async function fetchOpsConfig(){ fetches++; return globalThis.__opsValue; }",
      "function renderOpsNotice(){ return null; }",
      "function flushPendingNotice(){}",
      "function opsSeenIds(){ return []; }",
      extractFunction(playerCode, "refreshOps"),
      "return { refreshOps, state: () => ({ shown, hidden, fetches }) };"
    ].join("\n");
    return new Function(code)();
  })();

  globalThis.__opsValue = null;
  await box.refreshOps({ force: true });
  chk("配置拉不到 → 不停机（关键：失败开放）", box.state().shown, 0);
  chk("配置拉不到 → 明确撤掉维护页", box.state().hidden, 1);

  globalThis.__opsValue = { maintenance: true };
  await box.refreshOps({ force: true });
  chk("maintenance:true → 落维护页", box.state().shown, 1);

  globalThis.__opsValue = { maintenance: "true" };
  await box.refreshOps({ force: true });
  chk("maintenance:\"true\"（字符串）→ 不停机", box.state().shown, 1);
  chk("字符串 true 那次走了撤维护页分支（没落维护页）", box.state().hidden, 2);

  globalThis.__opsValue = null;
  const before = box.state().fetches;
  await box.refreshOps();          // 不带 force：应被节流挡掉
  chk("60 秒内不重复拉配置（切回页面不会刷屏）", box.state().fetches, before);
  await box.refreshOps({ force: true });
  chk("force（重试按钮）跳过节流", box.state().fetches, before + 1);
}

// ============================================================
console.log("\n--- 4. 维护闸门：只认 503 + maintenance:true ---");
// ============================================================
{
  const gateSrc = extractFunction(playerCode, "handleMaintenanceResponse");
  chkTrue("非 503 不拦（402/409 是另一回事）", /response\.status !== 503\) return false;/.test(gateSrc));
  chkTrue("503 但没 maintenance 标记 → 不拦（数据层抖动不是停机）",
    /payload\.maintenance !== true\) return false;/.test(gateSrc));

  const box = (() => {
    const code = [
      "let OPS_CONFIG = null;",
      "let shown = [];",
      "function showMaintenance(info){ shown.push(info); }",
      extractFunction(playerCode, "handleMaintenanceResponse"),
      "return { handleMaintenanceResponse, shown };"
    ].join("\n");
    return new Function(code)();
  })();
  chk("200 → 不拦", box.handleMaintenanceResponse({ status: 200 }, {}), false);
  chk("402 → 不拦", box.handleMaintenanceResponse({ status: 402 }, { error: "泡泡不足" }), false);
  chk("503 无 maintenance → 不拦", box.handleMaintenanceResponse({ status: 503 }, { error: "upstream down" }), false);
  chk("503 + maintenance:true → 拦", box.handleMaintenanceResponse({ status: 503 }, { maintenance: true }), true);
  chk("拦截时把服务端文案传下去", box.shown[0], { message: "", eta: "" });
  chk("拦截时带上预计恢复时间",
    box.handleMaintenanceResponse({ status: 503 }, { maintenance: true, error: "维护中", eta: "10 分钟后" }) && box.shown[1],
    { message: "维护中", eta: "10 分钟后" });

  // 四个写接口都必须挂闸门，漏一个就是「玩家能改但改不动」的静默失败。
  chkTrue("存档推送挂了闸门",
    /handleMaintenanceResponse\(response,failure\)/.test(extractFunction(playerCode, "pushCloudSave")));
  chkTrue("服务端结算挂了闸门",
    /handleMaintenanceResponse\(response,failure\)/.test(extractFunction(playerCode, "saveAquariumOnServer")));
  chkTrue("专注开始挂了闸门（失败不影响本地计时）",
    /handleMaintenanceResponse\(response, failure\);\s*\n\s*return;/.test(extractFunction(playerCode, "beginServerFocusSession")));
  chkTrue("专注结算挂了闸门且回落本地奖励（这一轮不能白做）",
    /handleMaintenanceResponse\(response, failure\);\s*\n\s*return \{ reward: localReward, source: "local" \};/
      .test(extractFunction(playerCode, "settleFocusReward")));
}

// ============================================================
console.log("\n--- 5. 公告有效期与已读 ---");
// ============================================================
{
  const keyLine = (playerCode.match(/const OPS_SEEN_KEY = "[^"]+";/) || [""])[0];
  chkTrue("已读记录有独立 key", /const OPS_SEEN_KEY = "[^"]+";/.test(keyLine), keyLine);

  const box = (() => {
    const code = [
      keyLine,
      "let OPS_CONFIG = null;",
      'const localStorage = { _d: {}, getItem(k){ return this._d[k] ?? null; }, setItem(k, v){ this._d[k] = String(v); } };',
      extractFunction(playerCode, "opsNotice"),
      extractFunction(playerCode, "opsSeenIds"),
      extractFunction(playerCode, "markOpsNoticeSeen"),
      "return { opsNotice, opsSeenIds, markOpsNoticeSeen, set: v => { OPS_CONFIG = v; }, raw: () => localStorage._d };"
    ].join("\n");
    return new Function(code)();
  })();

  const now = Date.now();
  const base = { id: "n1", active: true, title: "维护预告", body: "<p>今晚 22:00</p>" };

  box.set(null);
  chk("没配 → 没公告", box.opsNotice(), null);

  box.set({ notice: { ...base, active: false } });
  chk("active:false → 不显示", box.opsNotice(), null);

  box.set({ notice: { ...base, title: "", body: "" } });
  chk("空公告不显示（不弹一个空白框）", box.opsNotice(), null);

  box.set({ notice: { ...base, startAt: now + 3600000, endAt: now + 7200000 } });
  chk("还没到生效时间 → 不显示", box.opsNotice(), null);

  box.set({ notice: { ...base, startAt: now - 7200000, endAt: now - 3600000 } });
  chk("已过生效止 → 不显示", box.opsNotice(), null);

  const live = { ...base, startAt: now - 1000, endAt: now + 3600000 };
  box.set({ notice: live });
  chk("有效期内 → 显示", box.opsNotice(), live);

  box.set({ notice: { ...base } });
  chk("没填时间 → 按一直有效处理", box.opsNotice() !== null, true);

  // 已读裁剪：公告 id 会一直涨，不裁剪 localStorage 就无限变长。
  for (let i = 1; i <= 25; i++) box.markOpsNoticeSeen(`n${i}`);
  const seen = box.opsSeenIds();
  chk("已读列表只留最近 20 条", seen.length, 20);
  chk("留下的是最新的（最老的被裁掉）", [seen[0], seen[19]], ["n6", "n25"]);
  box.markOpsNoticeSeen("n25");
  chk("重复标记不会记两条", box.opsSeenIds().length, 20);
  box.markOpsNoticeSeen("");
  chk("空 id 不记录（记了就永远判成已读）", box.opsSeenIds().indexOf(""), -1);

  // 读不到 localStorage（隐私模式）不能抛错
  const privateBox = (() => {
    const code = [
      keyLine,
      'const localStorage = { getItem(){ throw new Error("denied"); }, setItem(){ throw new Error("denied"); } };',
      extractFunction(playerCode, "opsSeenIds"),
      extractFunction(playerCode, "markOpsNoticeSeen"),
      "return { opsSeenIds, markOpsNoticeSeen };"
    ].join("\n");
    return new Function(code)();
  })();
  chk("隐私模式读列表 → 空数组不抛错", privateBox.opsSeenIds(), []);
  chk("隐私模式写已读不抛错", (() => { privateBox.markOpsNoticeSeen("n1"); return "no-throw"; })(), "no-throw");
}

// ============================================================
console.log("\n--- 6. 公告弹窗：CTA 只放行 http(s) ---");
// ============================================================
{
  const openSrc = extractFunction(playerCode, "openOpsNotice");
  chkTrue("CTA 只放行 http/https（后台配错 javascript: 不能原样塞进 href）",
    openSrc.includes('indexOf("http://")') && openSrc.includes('indexOf("https://")'));
  chkTrue("非法 CTA 时把 href 复位成 #", /cta\.href = "#";/.test(openSrc));
  chkTrue("标题走纯文本（后台填错标签不会带崩版式）", /titleEl\.textContent = /.test(openSrc));

  // 运行时：真按假 DOM 跑一遍
  const box = (() => {
    const code = [
      "const els = {};",
      'const mk = id => ({ id, hidden: false, className: "", textContent: "", innerHTML: "", href: "#", classList: { add(){}, remove(){} }, setAttribute(){} });',
      'const document = { getElementById: id => (els[id] = els[id] || mk(id)) };',
      "let seen = [];",
      "function markOpsNoticeSeen(id){ seen.push(id); }",
      "function opsNotice(){ return globalThis.__notice; }",
      extractFunction(playerCode, "openOpsNotice"),
      "return { openOpsNotice, els, seen };"
    ].join("\n");
    return new Function(code)();
  })();

  globalThis.__notice = { id: "n1", title: "公告", body: "<p>正文</p>", ctaUrl: "javascript:alert(1)", ctaText: "点我" };
  box.openOpsNotice(globalThis.__notice);
  chk("javascript: 的 CTA 被拦下", box.els.noticeCta.hidden, true);
  chk("被拦下时 href 复位", box.els.noticeCta.href, "#");

  globalThis.__notice = { id: "n2", title: "公告", body: "<p>正文</p>", ctaUrl: "https://example.com/a", ctaText: "查看详情" };
  box.openOpsNotice(globalThis.__notice);
  chk("https CTA 放行", box.els.noticeCta.hidden, false);
  chk("CTA 文案用后台填的", box.els.noticeCta.textContent, "查看详情");
  chk("关闭过一次才算已读", box.seen, ["n1", "n2"]);

  globalThis.__notice = { id: "n3", title: "公告", body: "<p>正文</p>" };
  box.openOpsNotice(globalThis.__notice, { keepUnseen: true });
  chk("从顶栏图标点开重看不算已读（下次进页面还会弹）", box.seen, ["n1", "n2"]);
}

// ============================================================
console.log("\n--- 7. 首屏只弹一次，且给引导让位 ---");
// ============================================================
{
  const refreshSrc = extractFunction(playerCode, "refreshOps");
  chkTrue("没看过的公告才自动弹", /opsSeenIds\(\)\.indexOf\(id\) < 0/.test(refreshSrc));
  // 没 id 就没法记「已读」，自动弹会变成每次切回页面都弹一次 —— 那种公告只能靠图标看。
  chkTrue("没有 id 的公告不自动弹（否则每次切回页面都弹）",
    /if\(notice && id && /.test(refreshSrc));

  const flushSrc = extractFunction(playerCode, "flushPendingNotice");
  chkTrue("引导没看完就让位（两个全屏层不能叠着显示）",
    /if\(guide && !guide\.hidden\)\{ watchGuideEndOnce\(\); return; \}/.test(flushSrc));
  chkTrue("让位后靠监听引导收起来补弹（不改引导自己的状态机）",
    /new MutationObserver\(/.test(extractFunction(playerCode, "watchGuideEndOnce")));
  chkTrue("期间公告过期了就不弹", /if\(opsNotice\(\) !== notice\)\{ pendingNotice = null; return; \}/.test(flushSrc));

  chkTrue("停机中不引导（维护页已盖住界面，引导会在下面空跑）",
    /if\(maintenanceOn\) return;\s*\n\s*if\(window\.FISHTANK_DEFAULT_DATA && !guideSeen\(\)\) startGuide\(\);/.test(playerCode));
  chkTrue("切回页面时重查（停机／公告都是随时可能开的）",
    /addEventListener\("visibilitychange"[\s\S]{0,160}refreshOps\(\)/.test(playerCode));
  chkTrue("停机中定时重试（维护结束不用手动刷新）",
    /setInterval\(\(\) => \{ if\(maintenanceOn\) refreshOps\(\{ force: true \}\); \}/.test(playerCode));
}

console.log(`\n----\nplayer-ops-ui.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
