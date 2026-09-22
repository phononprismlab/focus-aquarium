// 音频分类体系（#9）的测试。
// 两部分：
//   1) 服务端校验规则 validateAudioConfig —— 直接 import。
//   2) 前端的分类纯函数 —— 从 index.html 里按名字抽取源码后求值，
//      这样测的是真实实现，不会因为手抄一份而跟线上代码走偏。
// 运行：node test/audio-categories.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAudioConfig, AUDIO_CATEGORY_KEY_PATTERN } from "../audio-config.js";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`PASS | ${name} = ${JSON.stringify(actual)}`);
    pass++;
  } else {
    console.log(`FAIL | ${name} 期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
    fail++;
  }
}

// ---------- 1. 服务端校验 ----------
console.log("--- 服务端 validateAudioConfig ---");
const okConfig = {
  categories: { bgm: { label: "背景白噪音", enabled: true, volume: 38 }, sfx: { label: "交互音效", enabled: true, volume: 100 } },
  sounds: [{ id: "water-ambient", name: "海水白噪音", category: "bgm", enabled: true, volume: 100 }]
};
chk("合法配置", validateAudioConfig(okConfig), null);
chk("自定义分类合法", validateAudioConfig({
  categories: { voice: { label: "人声", enabled: true, volume: 80 } },
  sounds: [{ id: "v1", name: "人声1", category: "voice", enabled: true, volume: 100 }]
}), null);
chk("缺少 categories", validateAudioConfig({ sounds: [] }), "音频配置必须包含 categories");
chk("categories 是数组", validateAudioConfig({ categories: [], sounds: [] }), "音频配置必须包含 categories");
chk("缺少 sounds", validateAudioConfig({ categories: { bgm: { label: "a", volume: 1 } } }), "音频配置必须包含 sounds 数组");
chk("分类为空", validateAudioConfig({ categories: {}, sounds: [] }), "至少需要保留一个音效分类");
chk("分类缺 label", validateAudioConfig({ categories: { bgm: { volume: 50 } }, sounds: [] }), "分类 bgm 必须填写名称");
chk("分类 label 全空格", validateAudioConfig({ categories: { bgm: { label: "   ", volume: 50 } }, sounds: [] }), "分类 bgm 必须填写名称");
chk("分类 key 含非法字符", validateAudioConfig({ categories: { "bad key": { label: "x", volume: 50 } }, sounds: [] }), "分类 key 只能是字母、数字、下划线或连字符（1-32 位）：bad key");
chk("分类音量越界", validateAudioConfig({ categories: { bgm: { label: "a", volume: 101 } }, sounds: [] }), "分类 bgm 的音量必须在 0-100 之间");
chk("音效缺 id", validateAudioConfig({ categories: { bgm: { label: "a", volume: 50 } }, sounds: [{ name: "n", category: "bgm" }] }), "每个音效必须包含 id、name、category");
chk("音效引用未定义分类", validateAudioConfig({
  categories: { bgm: { label: "a", volume: 50 } },
  sounds: [{ id: "s1", name: "n", category: "ghost", volume: 100 }]
}), "音效分类无效：ghost（不在已定义的分类中）");
chk("音效音量越界", validateAudioConfig({
  categories: { bgm: { label: "a", volume: 50 } },
  sounds: [{ id: "s1", name: "n", category: "bgm", volume: -1 }]
}), "音效 s1 的音量必须在 0-100 之间");
chk("key 正则接受连字符下划线数字", AUDIO_CATEGORY_KEY_PATTERN.test("bgm_2-mix"), true);
chk("key 正则拒绝空格", AUDIO_CATEGORY_KEY_PATTERN.test("a b"), false);
chk("key 正则拒绝超长", AUDIO_CATEGORY_KEY_PATTERN.test("a".repeat(33)), false);

// ---------- 2. 前端分类纯函数（从 index.html 抽取） ----------
console.log("--- 前端 index.html 抽取的纯函数 ---");
const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html");
const source = fs.readFileSync(htmlPath, "utf8");

// 按函数名做花括号配对，抽出一整个函数体，避免手抄导致实现漂移。
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}
function extractConst(src, name) {
  const match = src.match(new RegExp(`const ${name} = [^\\n]*;`));
  if (!match) throw new Error(`index.html 里找不到常量 ${name}`);
  return match[0];
}
// 多行的 const（如箭头函数体跨行）用花括号配对截取到语句结束的分号。
function extractConstBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`找不到 ${startMarker}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") {
      depth--;
      if (seen && depth === 0) return src.slice(start, src.indexOf(";", i) + 1);
    }
  }
  throw new Error(`${startMarker} 未闭合`);
}

const consts = [
  extractConst(source, "BUILTIN_AUDIO_CATEGORIES"),
  extractConst(source, "AUDIO_DEFAULTS"),
  extractConst(source, "audioStorageKey"),
  extractConst(source, "audioVolumes")
].join("\n");
const funcs = ["audioCategoryKeys", "audioCategoryLabel", "readStoredVolume", "syncAudioVolumeKeys", "escapeHtml", "ambientCategoryKey", "categoryScale"]
  .map(name => extractFunction(source, name))
  .join("\n");

// 用假的 AUDIO_CONFIG / localStorage 求值，模拟浏览器里的运行环境。
function buildSandbox(audioConfig, stored = {}) {
  const localStorage = {
    getItem: key => (Object.prototype.hasOwnProperty.call(stored, key) ? String(stored[key]) : null)
  };
  const factory = new Function("AUDIO_CONFIG", "localStorage", `${consts}\n${funcs}\nreturn { audioCategoryKeys, audioCategoryLabel, readStoredVolume, syncAudioVolumeKeys, escapeHtml, ambientCategoryKey, categoryScale, audioVolumes };`);
  return factory(audioConfig, localStorage);
}

// 配置未加载 → 用内置三类兜底
let sandbox = buildSandbox(null);
chk("无配置时分类为内置三类", sandbox.audioCategoryKeys(), ["bgm", "prompt", "sfx"]);
chk("无配置时 bgm 标签", sandbox.audioCategoryLabel("bgm"), "背景白噪音");
chk("无配置时未知 key 原样返回", sandbox.audioCategoryLabel("xyz"), "xyz");
chk("无配置时 ambient 取 bgm", sandbox.ambientCategoryKey(), "bgm");

// 后台自定义分类：删掉 prompt、新增 voice
const custom = {
  categories: {
    bgm: { label: "海浪", enabled: true, volume: 40 },
    voice: { label: "人声", enabled: true, volume: 70 }
  },
  sounds: []
};
sandbox = buildSandbox(custom);
chk("配置生效后分类来自后台", sandbox.audioCategoryKeys(), ["bgm", "voice"]);
chk("自定义分类标签生效", sandbox.audioCategoryLabel("voice"), "人声");
chk("bgm 标签被后台改写", sandbox.audioCategoryLabel("bgm"), "海浪");
chk("ambient 仍优先 bgm", sandbox.ambientCategoryKey(), "bgm");

// 后台把 bgm 也删了 → ambient 退而取第一个分类
const noBgm = { categories: { voice: { label: "人声", volume: 70 }, sfx: { label: "音效", volume: 100 } }, sounds: [] };
sandbox = buildSandbox(noBgm);
chk("无 bgm 时 ambient 取第一个分类", sandbox.ambientCategoryKey(), "voice");

// 音量读取与夹取
sandbox = buildSandbox(null, { fishTank_bgmVolume: 42 });
chk("读取已存音量", sandbox.readStoredVolume("bgm", 100), 42);
chk("未存时用回退值", sandbox.readStoredVolume("prompt", 55), 55);
chk("越界值被夹到 100", sandbox.readStoredVolume("sfx", 999), 100);
sandbox = buildSandbox(null, { fishTank_bgmVolume: "not-a-number" });
chk("非法值回落到 100", sandbox.readStoredVolume("bgm", 30), 100);
sandbox = buildSandbox(null, {});
chk("完全无存储时用回退值", sandbox.readStoredVolume("bgm", 30), 30);

// 音量表按分类补齐
sandbox = buildSandbox(custom);
sandbox.syncAudioVolumeKeys();
chk("syncAudioVolumeKeys 覆盖后台全部分类", Object.keys(sandbox.audioVolumes).sort(), ["bgm", "voice"]);

// HTML 转义：分类标签会进 DOM，必须转义
chk("escapeHtml 转义尖括号", sandbox.escapeHtml('<img src=x onerror="a">'), "&lt;img src=x onerror=&quot;a&quot;&gt;");
chk("escapeHtml 处理 null", sandbox.escapeHtml(null), "");

// ---------- 3. 后台模板（从 admin.html 抽取） ----------
console.log("--- 后台 admin.html 抽取的模板 ---");
const adminSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "admin.html"), "utf8");
const adminFns = ["categoryTemplate", "soundTemplate"].map(name => extractFunction(adminSource, name)).join("\n");
const adminConsts = [
  extractConst(adminSource, "audioCategoryLabel"),
  extractConstBlock(adminSource, "const audioCategoryKeys")
].join("\n");
const adminFactory = new Function("state", "DEFAULT_AUDIO", "esc", `${adminConsts}\n${adminFns}\nreturn { categoryTemplate, soundTemplate, audioCategoryKeys, audioCategoryLabel };`);
const adminEsc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const DEFAULT_AUDIO = { categories: { bgm: { label: "背景白噪音" } }, sounds: [] };

const adminState = {
  audio: {
    categories: { bgm: { label: "海浪", enabled: true, volume: 40 }, voice: { label: "人声", enabled: true, volume: 70 } },
    sounds: []
  }
};
const admin = adminFactory(adminState, DEFAULT_AUDIO, adminEsc);
chk("后台分类下拉来自后台配置", admin.audioCategoryKeys(), ["bgm", "voice"]);

const soundHtml = admin.soundTemplate({ id: "s1", name: "示例", category: "voice", enabled: true, volume: 80, resourcePath: "" }, 0);
chk("音效下拉含两个分类", (soundHtml.match(/<option /g) || []).length, 2);
chk("音效下拉按当前分类选中", soundHtml.includes('<option value="voice" selected>人声</option>'), true);
chk("音效下拉不含被删分类 prompt", soundHtml.includes("prompt"), false);

const categoryHtml = admin.categoryTemplate("voice", { label: "人声", enabled: true, volume: 70 });
chk("分类模板含可编辑名称输入", categoryHtml.includes('data-prop="label"'), true);
chk("分类模板含删除按钮", categoryHtml.includes('class="icon-button remove-category"'), true);
chk("分类模板回显名称", categoryHtml.includes('value="人声"'), true);
chk("分类模板展示 key", categoryHtml.includes("key：voice"), true);

// 配置里没有该分类时的兜底：仍用内置标签
const adminFallback = adminFactory({ audio: { categories: {}, sounds: [] } }, DEFAULT_AUDIO, adminEsc);
chk("空配置时回落到内置分类", adminFallback.audioCategoryKeys(), ["bgm"]);
chk("空配置时标签回落内置", adminFallback.audioCategoryLabel("bgm"), "背景白噪音");

// categoryScale（Bug 6：后台分类音量「算默认值」，不做上限缩放）
// 旧实现会把后台 category.volume 当成乘数（38 → 0.38），玩家滑块实际被二次压低；
// 现在 volume 只是滑块默认值，categoryScale 只表达「分类被关掉就静音」。
console.log("--- categoryScale（Bug 6：后台音量算默认值）---");
const scaleConfig = {
  categories: {
    bgm: { label: "背景白噪音", enabled: true, volume: 38 },
    sfx: { label: "交互音效", enabled: false, volume: 80 },
    prompt: { label: "提示音", enabled: true, volume: 100 }
  },
  sounds: []
};
const scaleSandbox = buildSandbox(scaleConfig);
chk("启用分类不受后台音量缩放影响", scaleSandbox.categoryScale("bgm"), 1);
chk("禁用分类为 0（静音）", scaleSandbox.categoryScale("sfx"), 0);
chk("另一个启用分类也是 1", scaleSandbox.categoryScale("prompt"), 1);
chk("未配置的分类为 1（不阻断播放）", scaleSandbox.categoryScale("nonexistent"), 1);
chk("旧实现曾返回 0.38（后台音量 38/100），现在必须是 1", scaleSandbox.categoryScale("bgm") !== 0.38, true);

console.log("----");
console.log(`audio-categories.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
