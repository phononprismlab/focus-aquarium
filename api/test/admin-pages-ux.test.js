// 回归测试：2026-09-25 管理后台体验改造（专注配置页 / 音效管理页 + 通用差异弹窗）。
//
// 覆盖 7 项需求里落在代码上的部分：
//   1) 技术字段翻译成业务语言（专注页标签、音效页标签、tier 行标签）；
//   2) 发布前差异对比（diffRows / publishSummary / openPublishDialog 接线）；
//   3) 错误不再只走 toast —— saveFocus / saveAudio 的校验与接口错误进 #formError，
//      音效上传失败贴着文件控件（showUploadError 支持直接传元素）；
//   4) 未保存离开拦截（renderFocus / renderAudio 挂 setLeaveGuard）；
//   5) 「已保存为草稿」状态条 + 查看差异/发布按钮。
//
// 沿用项目约定：零依赖假 DOM 跑 admin.html 的真实脚本，不引 jsdom。
// 运行：node test/admin-pages-ux.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..", "..");
const adminHtml = fs.readFileSync(path.join(projectRoot, "admin.html"), "utf8").replace(/\r\n/g, "\n");
const gameDataSource = fs.readFileSync(path.join(projectRoot, "game-data.js"), "utf8");

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

// ===== 极简假 DOM（与 admin-decoration-form.test.js 同一套约定）=====
function makeElement(id = "") {
  const el = {
    id, tagName: "div", innerHTML: "", textContent: "", value: "", hidden: false, checked: false,
    dataset: {}, style: {}, children: [], onclick: null, onchange: null, onsubmit: null,
    elements: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs = { ...(this.attrs || {}), [k]: v }; },
    getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    remove() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  return el;
}
const elements = new Map();
const fakeDocument = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
  querySelectorAll() { return []; },
  querySelector() { return makeElement(); },
  createElement(tag) { return makeElement(""); },
  addEventListener() {}
};
const fakeWindow = {};
new Function("window", gameDataSource)(fakeWindow);

const scriptSource = adminHtml.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

const toasts = [];
const requests = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) });

function bootAdmin() {
  toasts.length = 0;
  requests.length = 0;
  elements.clear();
  const api = new Function(
    "document", "window", "sessionStorage", "localStorage", "fetch", "FormData", "focus",
    `${scriptSource}
return { state, renderModule, renderFocus, renderAudio, saveAudio, publishItem, focusConfig, diffRows, shortValue, publishSummary, showToast };`
  )(
    fakeDocument, fakeWindow,
    { getItem: () => null, setItem() {}, removeItem() {} },
    { getItem: () => null, setItem() {}, removeItem() {} },
    (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
    class FakeFormData {},
    function focus() {}
  );
  return api;
}
function lastToast() { return toasts[toasts.length - 1] ?? ""; }

// fake DOM 不解析 innerHTML，showToast 拿不到 #toast 元素的内容 —— 这里直接接住它写不进去的调用。
// （scriptSource 里 showToast 是页面自己的实现，往 #toast 写 textContent；假 DOM 里那个元素存在但读不到时间差，
//   所以 toast 断言改走源码锚 + 表单错误断言，toast 只在能读到时用。）

// ===== 1. 专注配置页：业务语言 + 错误进表单 =====
console.log("--- 1. 专注配置页 ---");
chkTrue("两个时长字段是业务中文标签（不再裸露 minFocusDuration）",
  /<label>最短专注时长（分钟）<\/label>/.test(scriptSource) && /<label>最长专注时长（分钟）<\/label>/.test(scriptSource));
chkTrue("专注页不再出现裸技术字段标签", !/<label>minFocusDuration<\/label>/.test(scriptSource) && !/<label>maxFocusDuration<\/label>/.test(scriptSource));
chkTrue("梯度行标签业务化（编号/结束时间/两种泡泡速率）",
  /<label>梯度编号<\/label>/.test(scriptSource) && /<label>结束时间（分钟）<\/label>/.test(scriptSource)
  && /<label>普通用户泡泡 \/ 分钟<\/label>/.test(scriptSource) && /<label>会员泡泡 \/ 分钟<\/label>/.test(scriptSource));
chkTrue("奖励梯度小节不再是「rewardTiers」标题", !/<h3 class="section-title">rewardTiers /.test(scriptSource));
chkTrue("专注页有自己的 #formError（校验错误不再靠 toast）",
  /pageHeader\("FOCUS CONFIG"[\s\S]{0,400}form-error" id="formError"/.test(scriptSource));
chkTrue("saveFocus 校验失败走 showFormError（表单内错误）",
  /if \(errors\.length\) \{ showFormError\(null, `保存失败：\$\{errors\.join\("；"\)\}`\); return; \}/.test(scriptSource));
{
  // 反向验证：saveFocus 函数体区间内不允许出现 showToast(`保存失败
  const start = scriptSource.indexOf('document.getElementById("saveFocus").onclick');
  const end = scriptSource.indexOf("const focusDraft", start);
  chkTrue("saveFocus 区间里没有 toast 报错", start !== -1 && end > start && !scriptSource.slice(start, end).includes("showToast(`保存失败"));
}
chkTrue("saveFocus 新增业务校验：最短专注时长必须大于 0", /最短专注时长必须大于 0/.test(scriptSource));
chkTrue("保存成功后提示「已保存为草稿」并点亮状态条数据", /lastSaved = \{ type: "focus", id: "focus" \}/.test(scriptSource) && /已保存为草稿，等待发布/.test(scriptSource));

// renderFocus 真跑一遍：页面写进 main，且不抛错
{
  const api = bootAdmin();
  let error = null;
  try { api.renderFocus(); } catch (e) { error = `${e.constructor.name}: ${e.message}`; }
  chk("renderFocus() 不抛错", error, null);
  const html = fakeDocument.getElementById("main").innerHTML;
  chkTrue("页面包含业务标签与保存按钮", html.includes("FOCUS CONFIG") && html.includes("最短专注时长（分钟）") && html.includes("保存配置"));
  chkTrue("页面没有 undefined（渲染完整性）", !html.includes("undefined"));
}
// 校验失败：空输入 → #formError 里有中文报错，且没有发请求
{
  const api = bootAdmin();
  api.renderFocus();
  requests.length = 0;
  const handler = fakeDocument.getElementById("saveFocus").onclick;
  chkTrue("saveFocus 已绑到按钮上", typeof handler === "function");
  await handler();
  const box = fakeDocument.getElementById("formError");
  chkTrue("校验错误写进了 #formError", box.hidden === false && /保存失败/.test(box.textContent) && /最短专注时长/.test(box.textContent));
  chk("校验失败时不发任何请求", requests.length, 0);
}
// 保存成功：写回 state、toast「已保存为草稿」、发 PUT
{
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { data: { minFocusDuration: 25, maxFocusDuration: 120, rewardTiers: [] }, published: false, publishedData: { minFocusDuration: 10, maxFocusDuration: 60, rewardTiers: [] } } }) });
  const api = bootAdmin();
  api.renderFocus();
  fakeDocument.getElementById("minFocusDuration").value = "25";
  fakeDocument.getElementById("maxFocusDuration").value = "120";
  requests.length = 0;
  await fakeDocument.getElementById("saveFocus").onclick();
  chk("保存成功写回 state.focus", [api.state.focus.minFocusDuration, api.state.focus.maxFocusDuration], [25, 120]);
  chkTrue("发了 PUT /admin/focus/focus", requests.some(r => r.url.includes("/admin/focus/focus") && r.options.method === "PUT"));
}
// 发布：确认弹窗在测试环境放行 → 直接发 publish 请求
{
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { data: { minFocusDuration: 25 }, published: true } }) });
  const api = bootAdmin();
  api.renderFocus();
  requests.length = 0;
  await fakeDocument.getElementById("publishFocus").onclick();
  chkTrue("发布发的是 /admin/focus/focus/publish", requests.some(r => r.url.includes("/admin/focus/focus/publish") && r.options.method === "POST"));
}

// ===== 2. 音效管理页 =====
console.log("\n--- 2. 音效管理页 ---");
chkTrue("音效行标签业务化（编号/音频文件，不再裸露 id/resourcePath）",
  /<label>编号<\/label><input data-prop="id"/.test(scriptSource) && /<label>音频文件<\/label>/.test(scriptSource));
chkTrue("音效页有自己的 #formError", /pageHeader\("AUDIO CONFIG"[\s\S]{0,400}form-error" id="formError"/.test(scriptSource));
chkTrue("saveAudio 校验失败走 showFormError", /if \(errors\.length\) \{ showFormError\(null, `保存失败：\$\{errors\.join\("；"\)\}`\); return; \}[\s\S]{0,600}apiRequest\("\/admin\/audio\/audio"/.test(scriptSource));
chkTrue("saveAudio 报错文案业务化（编号/名称，不再是 id 和 name）", !/每个音效都必须填写 id 和 name/.test(scriptSource) && /每个音效都必须填写编号和名称/.test(scriptSource));
{
  const start = scriptSource.indexOf("async function saveAudio()");
  const end = scriptSource.indexOf("function renderPlaceholder", start);
  chkTrue("saveAudio 区间里没有 toast 报错", start !== -1 && end > start && !scriptSource.slice(start, end).includes("showToast(`保存失败"));
}
chkTrue("音效上传失败贴着文件控件（showUploadError 收元素）并顶到 banner",
  /fallbackError\) \{[\s\S]{0,200}showUploadError\(input, message\);[\s\S]{0,200}showErrorBanner\(/.test(scriptSource));
chkTrue("showUploadError 支持直接传元素", /typeof controlId === "string" \? document\.getElementById\(controlId\) : controlId/.test(scriptSource));
chkTrue("音效页发布走差异弹窗（不再只有 confirm）",
  /runPublishAudio = async \(\) => \{\n\t\t\t\tif \(!await openPublishDialog\(audioDraft\(\), "音效配置"\)\) return;/.test(scriptSource));
chkTrue("音效保存成功点亮状态条", /lastSaved = \{ type: "audio", id: "audio" \}/.test(scriptSource));
// saveAudio 空分类 → #formError
{
  const api = bootAdmin();
  api.renderAudio();
  const handler = fakeDocument.getElementById("saveAudio").onclick;
  chkTrue("saveAudio 已绑到按钮上", typeof handler === "function");
  await handler();
  const box = fakeDocument.getElementById("formError");
  chkTrue("空分类校验写进了 #formError", box.hidden === false && /至少要保留一个音效分类/.test(box.textContent));
}

// ===== 3. 发布差异对比 =====
console.log("\n--- 3. 发布差异对比 ---");
{
  const api = bootAdmin();
  chk("publishedData 为空 → 全新配置（null）", api.diffRows({ publishedData: null, data: { name: "新" } }), null);
  chk("publishedData 为空对象 → 全新配置（null）", api.diffRows({ publishedData: {}, data: { name: "新" } }), null);
  const rows = api.diffRows({ publishedData: { price: 25, description: "旧的" }, data: { price: 40, description: "旧的" } });
  chk("只列有变化的字段，label 用业务名", rows.map(r => [r.key, r.label]), [["price", "价格（泡泡）"]]);
  const many = api.diffRows({ publishedData: { price: 1, name: "a", description: "b" }, data: { price: 2, name: "c", description: "d" } });
  chk("多个变化全部列出", many.length, 3);
  chk("没有变化时返回空数组（= 一致）", api.diffRows({ publishedData: { price: 25 }, data: { price: 25 } }), []);
  chk("publishSummary：全新配置文案", api.publishSummary({ publishedData: null, data: {} }), "将发布：全新配置（线上还没有这份）");
  chk("publishSummary：一致文案", api.publishSummary({ publishedData: { price: 25 }, data: { price: 25 } }), "草稿与线上版本一致");
  chkTrue("publishSummary：有变化时列字段名", /将发布：价格（泡泡）/.test(api.publishSummary({ publishedData: { price: 1 }, data: { price: 2 } })));
  chk("shortValue：布尔 → 是/否", [api.shortValue(true), api.shortValue(false)], ["是", "否"]);
  chk("shortValue：空 → （空）", api.shortValue(""), "（空）");
  chk("shortValue：对象带 slot/path → 文件名", api.shortValue({ slot: "back", path: "images/a/b.png" }), "back: b.png");
}
chkTrue("专注/音效发布都接了差异弹窗", /openPublishDialog\(focusDraft\(\), "专注配置"\)/.test(scriptSource) && /openPublishDialog\(audioDraft\(\), "音效配置"\)/.test(scriptSource));
chkTrue("发布失败不再走 toast（专注/音效页改 showFormError）",
  !/showToast\(`发布失败：\$\{error\.message\}`, 5000, "error"\)/.test(scriptSource));

// ===== 4. 「已保存为草稿」状态条 =====
console.log("\n--- 4. 已保存为草稿状态条 ---");
chkTrue("专注页状态条含「已保存为草稿 / 当前线上版本 / 查看差异 / 发布」",
  /saved-banner[\s\S]{0,200}已保存为草稿。[<\/b>]*当前线上版本：[\s\S]{0,200}focusViewDiff[\s\S]{0,120}focusPublishNow/.test(scriptSource));
chkTrue("音效页状态条同构", /audioViewDiff[\s\S]{0,120}audioPublishNow/.test(scriptSource));
chkTrue("状态条上的「查看差异」走 showDiffDialog（只看不发）",
  /stripDiff\.onclick = \(\) => showDiffDialog\(focusDraft\(\), "专注配置"\)/.test(scriptSource)
  && /stripDiff\.onclick = \(\) => showDiffDialog\(audioDraft\(\), "音效配置"\)/.test(scriptSource));

// ===== 5. 未保存离开拦截 =====
console.log("\n--- 5. 未保存离开拦截 ---");
chkTrue("renderFocus / renderAudio 都挂了 leave guard",
  /function renderFocus\(\) \{\n\t\t\tconst focus = focusConfig\(\);\n\t\t\tsetLeaveGuard\(\(\) => focusGuardOn\);/.test(scriptSource)
  && /setLeaveGuard\(\(\) => audioGuardOn\);/.test(scriptSource));
chkTrue("编辑输入会把 guard 打开", /focusGuardOn = true/.test(scriptSource) && /audioGuardOn = true/.test(scriptSource));
chkTrue("保存 / 发布成功后解除 guard", /focusGuardOn = false;/.test(scriptSource) && /audioGuardOn = false;/.test(scriptSource));

// ===== 6. 连接状态卡 =====
console.log("\n--- 6. 连接状态卡 ---");
chkTrue("有连接状态卡 DOM（connDot / connTitle / connToggle / connMeta）",
  /id="connDot"[\s\S]{0,200}id="connTitle"[\s\S]{0,200}id="connToggle"[\s\S]{0,320}id="connMeta"/.test(adminHtml));
chkTrue("连接成功后收起密钥输入（collapseConnBody）", /function collapseConnBody\(\)/.test(scriptSource));
chkTrue("启动时探 /health 读环境（不要求密钥）", /refreshConnEnv[\s\S]{0,400}\/health/.test(scriptSource));

console.log("----");
console.log(`admin-pages-ux.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
