// 回归测试：后台三个真实踩过的坑。
//
// 1) 点「专注配置」页签没反应 —— renderFocus() 里写的是裸 `focus`。
//    浏览器里 window.focus 是内置函数，裸 focus 会静默指向它，于是 focus.rewardTiers 是 undefined，
//    .map 抛 TypeError，整个页签渲染不出来（main.innerHTML 都没赋上）。
//    ⚠️ 这个 bug 在 Node 里跑不出来：Node 没有全局 focus，裸 focus 直接 ReferenceError，
//    报错信息完全不同。所以测试必须**显式注入一个 focus 全局**来模拟浏览器。
//
// 2) 「发布失败：Cannot read properties of undefined (reading 'map')」——
//    发布其实成功了，是发布之后调 renderModule() 渲染出错，被 publishItem 的 try 一起接住、
//    报成了「发布失败」。往错的方向查了半天。
//
// 3) 新建商品时 resourcePath 看着"自动挂了一条音频路径还删不掉"：
//    <select> 默认选中第一项（正好是个音频文件）；chip 是个纯 span，没有任何删除入口；
//    而且「上传资源」根本没上传，直接把本地文件名 file.name 写进了配置（发布出去必然 404）。
//
// 沿用项目约定：零依赖假 DOM 跑 admin.html 的真实脚本，不引 jsdom。
// 运行：node test/admin-decoration-form.test.js
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

// ===== 极简假 DOM（够 admin.html 用）=====
function makeElement(id = "") {
  const el = {
    id, tagName: "div", innerHTML: "", textContent: "", value: "", hidden: false, checked: false,
    dataset: {}, style: {}, children: [], onclick: null, onchange: null, onsubmit: null,
    // admin.html 会读 formEl.elements.category.value 判断分类；真实 DOM 里这是表单里的 <select>。
    elements: { category: { value: "decorations" }, isMemberOnly: { checked: false } },
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

// 收集 showToast 的文案
const toasts = [];
// 收集 fetch 请求，供断言
const requests = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) });

// FormData 垫片：formData(form) 里用 Object.fromEntries(new FormData(form).entries())
class FakeFormData {
  constructor(form) { this.entriesMap = Object.entries(form?.__entries || {}); }
  entries() { return this.entriesMap[Symbol.iterator](); }
  append(key, value) { this.entriesMap.push([key, value]); }
}

function bootAdmin({ focus = undefined } = {}) {
  toasts.length = 0;
  requests.length = 0;
  elements.clear();
  const api = new Function(
    "document", "window", "sessionStorage", "localStorage", "fetch", "FormData", "focus",
    `${scriptSource}
return { state, render, renderModule, renderFocus, renderDecorationForm, renderDecorationList, publishItem, focusConfig, makeFileChip, audioResourceOptions, showToast };`
  )(
    fakeDocument, fakeWindow,
    { getItem: () => null, setItem() {}, removeItem() {} },
    { getItem: () => null, setItem() {}, removeItem() {} },
    (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
    FakeFormData,
    // ⚠️ 关键：模拟浏览器的 window.focus。不注入它，裸 focus 会 ReferenceError，
    //    测不出线上真正的 TypeError。
    function focus() {}
  );
  if (focus !== undefined) api.state.focus = focus;
  return api;
}

// 把 showToast 的输出接到 toasts 上（脚本内部调用的是它自己的 showToast，所以只能读 DOM 里的 #toast）
function lastToast() { return fakeDocument.getElementById("toast").textContent; }

// ===== 1. renderFocus 不能再炸 =====
console.log("--- 1. 专注配置页签必须能渲染出来 ---");
{
  const api = bootAdmin();
  let error = null;
  try { api.renderFocus(); } catch (e) { error = `${e.constructor.name}: ${e.message}`; }
  chk("renderFocus() 不抛错", error, null);
  const html = fakeDocument.getElementById("main").innerHTML;
  chkTrue("确实写进了页面（不是「点了没反应」）", /FOCUS CONFIG/.test(html) && /rewardTiers/.test(html));
  chkTrue("页面里没有 undefined（裸 focus 的典型症状）", !/undefined/.test(html));
  chkTrue("三个内置梯度都渲染出来了", (html.match(/class="tier-row"/g) || []).length === 3);
}
{
  // 配置被写坏（rewardTiers 不是数组）时也不能把页签锁死。
  const api = bootAdmin({ focus: { minFocusDuration: 25, maxFocusDuration: 120, rewardTiers: "坏数据" } });
  let error = null;
  try { api.renderFocus(); } catch (e) { error = e.message; }
  chk("rewardTiers 被写坏时不抛错（兜底成空数组）", error, null);
  chk("坏数据被就地修好", Array.isArray(api.state.focus.rewardTiers), true);
}
{
  const api = bootAdmin({ focus: undefined });
  chk("state.focus 缺失时也能拿到可用配置", (() => { const f = api.focusConfig(); return [typeof f, Array.isArray(f.rewardTiers)]; })(), ["object", true]);
}
{
  // 「裸 focus」的判定必须带作用域：renderFocus 里有一个合法的局部 const focus，
  // 直接全文正则会把 4 处合法引用和 1 行注释一起误判。做法：去掉注释行，
  // 再确认剩下的 focus.xxx 全部落在 renderFocus 的函数体区间内。
  const noComments = scriptSource.replace(/^[ \t]*\/\/.*$/gm, "");
  const focusStart = noComments.indexOf("function renderFocus()");
  const nextFn = noComments.indexOf("\n\t\tfunction ", focusStart + 1);
  const focusEnd = nextFn === -1 ? noComments.length : nextFn;
  chkTrue("能定位到 renderFocus 函数体", focusStart !== -1 && focusEnd > focusStart);
  const offenders = [];
  const re = /(^|[^.\w"'])focus\.(minFocusDuration|maxFocusDuration|rewardTiers)/g;
  let match;
  while ((match = re.exec(noComments)) !== null) {
    const at = match.index + match[1].length;
    if (at < focusStart || at >= focusEnd) offenders.push(noComments.slice(Math.max(0, at - 60), at + 30).replace(/\n/g, " "));
  }
  chk("renderFocus 之外没有裸 focus 引用", offenders, []);
  chkTrue("renderFocus 第一行就取局部 const focus", /function renderFocus\(\) \{\n\t\t\tconst focus = focusConfig\(\);/.test(scriptSource));
  chkTrue("focusConfig() 是唯一读取点", /function focusConfig\(\) \{[\s\S]{0,300}return state\.focus;/.test(scriptSource));
}

// ===== 2. 单模块渲染失败不能表现成「页签没反应」 =====
console.log("\n--- 2. 模块渲染失败要说清楚，而不是静默无反应 ---");
{
  const api = bootAdmin();
  // 制造一个必然失败的渲染器：把商品列表数据写成 null，renderDecorationList 读 .length 就会抛。
  // ⚠️ 不能用 state.focus = null —— focusConfig() 会把它就地修好，反而测不出异常面板。
  api.state.module = "decorations";
  api.state.decorations = null;
  let error = null;
  try { api.renderModule(); } catch (e) { error = e.message; }
  chk("renderModule() 自己接住异常（不往外抛）", error, null);
  chkTrue("页面上给出了可读的错误说明", /这个页面渲染失败了/.test(fakeDocument.getElementById("main").innerHTML));
  chkTrue("错误面板写明了是哪个模块", /模块：decorations/.test(fakeDocument.getElementById("main").innerHTML));
}
{
  // 反过来：专注配置即使 state.focus 被写坏，也**不该**落到异常面板上（兜底生效）。
  const api = bootAdmin();
  api.state.module = "focus";
  api.state.focus = null;
  api.renderModule();
  chkTrue("state.focus 被清空时仍然渲染出正常页面（不报错面板）",
    /FOCUS CONFIG/.test(fakeDocument.getElementById("main").innerHTML) && !/这个页面渲染失败了/.test(fakeDocument.getElementById("main").innerHTML));
}
chkTrue("renderModule 里有 try/catch", /function renderModule\(\)[\s\S]{0,400}try \{ renderer\(\); \}/.test(scriptSource));
chkTrue("错误面板会写明是哪个模块", /模块：\$\{esc\(state\.module\)\}/.test(scriptSource));

// ===== 3. 发布不能被渲染错误误报成「发布失败」 =====
console.log("\n--- 3. 发布成功就该说成功 ---");
await (async () => {
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { published: true } }) });
  const api = bootAdmin();
  api.state.module = "decorations";
  api.state.decorations = [{ id: "d1", name: "测试商品", dirty: true, published: false }];
  await api.publishItem("decorations", 0);
  chk("发布成功后提示的是「已发布」", lastToast(), "内容已发布");
  chk("条目标记为已发布", [api.state.decorations[0].published, api.state.decorations[0].dirty], [true, false]);
})();
await (async () => {
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ error: "服务端炸了" }) });
  const api = bootAdmin();
  api.state.module = "decorations";
  api.state.decorations = [{ id: "d1", name: "测试商品", dirty: true, published: false }];
  await api.publishItem("decorations", 0);
  chk("真正的接口失败才报「发布失败」", lastToast(), "发布失败：服务端炸了");
})();
chkTrue("renderModule() 在 try 之外（渲染错误不会被报成发布失败）",
  /showToast\("内容已发布"\);\n\t\t\t\} catch \(error\) \{ showToast\(`发布失败：\$\{error\.message\}`\); return; \}\n\t\t\t[\s\S]{0,300}renderModule\(\);/.test(scriptSource));

// ===== 4. resourcePath 不再"自动挂一条音频路径" =====
console.log("\n--- 4. 资源选择框：默认必须是明确的「不挂资源」 ---");
{
  const api = bootAdmin();
  const options = api.audioResourceOptions();
  chkTrue("第一项是空值占位（<select> 默认选第一项，不能是音频文件）", /^<option value="">/.test(options));
  chkTrue("占位文案说清是「不挂资源」", /不挂资源/.test(options));
  chkTrue("真实音频选项排在占位之后", options.indexOf("assets/sounds/water-ambient.mp3") > options.indexOf("不挂资源"));
}
chkTrue("选中后会把 select 复位成空值（避免「看着还挂着」）",
  /resourcePick"\)\.onchange = event => \{\n\t\t\t\tconst path = event\.target\.value;\n\t\t\t\tevent\.target\.value = "";/.test(scriptSource));

// ===== 5. chip 必须能删 =====
console.log("\n--- 5. 资源 chip 要能删掉 ---");
chkTrue("有 .chip-remove 样式", /\.chip-remove \{/.test(adminHtml));
{
  const api = bootAdmin();
  let removed = 0;
  const chip = api.makeFileChip("后景：images/a.png", "images/a.png", () => { removed += 1; });
  chk("chip 带 data-path", chip.dataset.path, "images/a.png");
  chk("chip 里有一个删除按钮", chip.children.filter(c => c.className === "chip-remove").length, 1);
  const button = chip.children.find(c => c.className === "chip-remove");
  // ⚠️ 这里必须容错：修复被回退时 button 是 undefined，直接调 .onclick() 会让整个测试文件崩掉，
  //    后面的断言一条都跑不到（反向验证时踩过）。崩掉比 FAIL 更难查。
  chkTrue("能找到删除按钮", Boolean(button));
  if (button) button.onclick();
  chk("点删除按钮会回调", removed, 1);
  chk("按钮文案是 ×", button ? button.textContent : "(没有删除按钮)", "×");
}
chkTrue("预览图 chip 也挂了删除回调", /renderPreviewChip[\s\S]{0,200}previewPath = ""; renderPreviewChip\(\);/.test(scriptSource));
chkTrue("资源 chip 删除后重新编号（后景/前景不会错位）",
  /resourcePaths = resourcePaths\.filter\(existing => existing !== path\);\n\t\t\t\t\trenderResourceChips\(\);/.test(scriptSource));

// ===== 6. 「上传资源」必须真的上传 =====
console.log("\n--- 6. 上传资源要真的传到云存储，不能只写本地文件名 ---");
chkTrue("不再把 file.name 当路径写进配置", !/addResourceChip\(file\.name/.test(scriptSource));
chkTrue("有统一的 uploadAsset（按 MIME 选接口）",
  /async function uploadAsset\(file, label\)[\s\S]{0,400}startsWith\("audio\/"\) \? "\/admin\/assets" : "\/admin\/assets\/image"/.test(scriptSource));
{
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { path: "images/uploaded-1.png", url: "" } }) });
  const api = bootAdmin();
  api.renderDecorationForm();
  const upload = fakeDocument.getElementById("resourceUpload");
  chkTrue("resourceUpload 绑了 onchange", typeof upload.onchange === "function");
  await upload.onchange({ target: { files: [{ name: "罗莎.jpg", type: "image/jpeg" }], value: "" } });
  chk("图片走 /admin/assets/image", requests.map(r => r.url.split("/api")[1]), ["/admin/assets/image"]);
  const list = fakeDocument.getElementById("resourceFiles");
  chk("chip 用的是上传返回的路径，不是本地文件名", list.children.map(c => c.dataset.path), ["images/uploaded-1.png"]);
  chkTrue("本地文件名没进 data-path", !list.children.some(c => c.dataset.path === "罗莎.jpg"));
}
{
  // 云存储失败（回落本地）时必须拒绝写入配置，否则发布出去必然 404。
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { path: "uploads/tmp.png", fallbackError: "云存储不可用" } }) });
  const api = bootAdmin();
  api.renderDecorationForm();
  await fakeDocument.getElementById("resourceUpload").onchange({ target: { files: [{ name: "a.png", type: "image/png" }], value: "" } });
  chk("回落本地的路径不写进资源列表", fakeDocument.getElementById("resourceFiles").children.length, 0);
  chkTrue("并明确告诉用户没保存", /未保存/.test(lastToast()));
}
{
  // 音频文件要走音频接口（存 sounds/）
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { path: "sounds/a.mp3" } }) });
  const api = bootAdmin();
  api.renderDecorationForm();
  await fakeDocument.getElementById("resourceUpload").onchange({ target: { files: [{ name: "a.mp3", type: "audio/mpeg" }], value: "" } });
  chk("音频走 /admin/assets", requests.map(r => r.url.split("/api")[1]), ["/admin/assets"]);
}

// ===== 7. 保存时直接用数组，不从 chip 文案反解 =====
console.log("\n--- 7. 保存的 payload 取自数组，不从文案反解 ---");
chkTrue("不再从 chip.textContent 反解路径", !/textContent\.replace\(\/\^\(后景\|前景\|资源\)/.test(scriptSource));
chkTrue("resourcePath 直接来自 resourcePaths", /data\.resourcePath = \[\.\.\.resourcePaths\];/.test(scriptSource));
chkTrue("previewImage 直接来自 previewPath", /data\.previewImage = previewPath;/.test(scriptSource));
{
  // 端到端：上传一张资源图 + 一张预览图，然后提交，看真正发出去的 body。
  fetchImpl = async (url) => {
    if (String(url).includes("/admin/assets")) return { ok: true, status: 200, json: async () => ({ data: { path: url.includes("image") ? "images/res.png" : "sounds/res.mp3" } }) };
    return { ok: true, status: 200, json: async () => ({ data: { data: { id: "d9", name: "新商品" }, published: false } }) };
  };
  const api = bootAdmin();
  api.renderDecorationForm();
  await fakeDocument.getElementById("resourceUpload").onchange({ target: { files: [{ name: "res.png", type: "image/png" }], value: "" } });
  await fakeDocument.getElementById("previewUpload").onchange({ target: { files: [{ name: "thumb.png", type: "image/png" }], value: "" } });

  const form = fakeDocument.getElementById("decorationForm");
  form.__entries = { id: "d9", category: "decorations", name: "新商品", price: "0", description: "", tags: "", maxInventory: "1" };
  let prevented = false;
  await form.onsubmit({ preventDefault: () => { prevented = true; }, target: form });
  chk("提交时阻止了表单默认行为", prevented, true);
  const saveRequest = requests.find(r => r.url.includes("/admin/decorations") && !r.url.includes("/assets"));
  chkTrue("发出了保存请求", Boolean(saveRequest));
  const payload = JSON.parse(saveRequest.options.body);
  chk("resourcePath 是上传返回的路径", payload.resourcePath, ["images/res.png"]);
  chk("previewImage 是上传返回的路径", payload.previewImage, "images/res.png");
  chk("tags 解析成数组", payload.tags, []);
}

console.log("\n----");
console.log(`admin-decoration-form.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
