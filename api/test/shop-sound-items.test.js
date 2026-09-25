// 后台音频配置 → 商店「白噪音」商品的映射测试。
//
// 这里锁的是一个曾经把玩家内容顶掉的 bug：
//   serverSoundItems 原来用 `item.resourcePath === sound.resourcePath` 关联商品与音效，
//   但商品侧 resourcePath 是数组（后台保存后统一成数组）、音效侧是字符串，
//   两边永远匹配不上，于是 legacy 恒为空对象 ——
//   商店里显示的名字变成「音效管理」里填的名字，描述变成兜底文案
//   「来自后台音频配置的背景音」，玩家在装点鱼缸配置里写的名称与描述全部失效。
//
// 同 audio-categories.test.js：按函数名从 index.html 里抽真实实现求值，
// 不手抄一份，避免测试和线上代码走偏。
// 运行：node test/shop-sound-items.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

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

// 按函数名做花括号配对，抽出一整个函数体。
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

const consts = [
  extractConst(source, "BUILTIN_AUDIO_CATEGORIES"),
  extractConst(source, "AUDIO_DEFAULTS"),
  extractConst(source, "audioStorageKey"),
  extractConst(source, "audioVolumes"),
  // sortShopItems 会按类型分组，分组顺序来自这个常量（排序规则本身的测试在 shop-sort.test.js）。
  extractConst(source, "SHOP_CATEGORY_ORDER")
].join("\n");
const funcs = ["audioCategoryKeys", "ambientCategoryKey", "resourceBasename", "itemResourcePaths", "serverSoundItems", "sortShopItems"]
  .map(name => extractFunction(source, name))
  .join("\n");

function buildSandbox(audioConfig, shopItems) {
  const factory = new Function("AUDIO_CONFIG", "SHOP_ITEMS", `${consts}\n${funcs}\nreturn { serverSoundItems, resourceBasename, itemResourcePaths, ambientCategoryKey, sortShopItems };`);
  return factory(audioConfig, shopItems);
}

const audioConfig = {
  categories: {
    bgm: { label: "背景白噪音", enabled: true, volume: 38 },
    prompt: { label: "提示音", enabled: true, volume: 100 },
    sfx: { label: "交互音效", enabled: true, volume: 100 }
  },
  sounds: [
    { id: "water-ambient", name: "后台填的名字", category: "bgm", enabled: true, volume: 100, resourcePath: "assets/sounds/water-ambient.mp3" },
    { id: "ocean", name: "海浪", category: "bgm", enabled: true, volume: 100, resourcePath: "/uploads/sounds/1790-ocean-waves.mp3" },
    { id: "focus-start", name: "开始专注", category: "prompt", enabled: true, volume: 100, resourcePath: "assets/sounds/start.mp3" },
    { id: "muted-one", name: "已停用", category: "bgm", enabled: false, volume: 100, resourcePath: "assets/sounds/muted.mp3" },
    { id: "no-file", name: "没上传", category: "bgm", enabled: true, volume: 100, resourcePath: "" }
  ]
};

console.log("--- resourceBasename / itemResourcePaths ---");
let sandbox = buildSandbox(audioConfig, []);
chk("带目录的文件名", sandbox.resourceBasename("assets/sounds/water-ambient.mp3"), "water-ambient.mp3");
chk("查询串被忽略", sandbox.resourceBasename("/uploads/sounds/a.mp3?sign=xyz"), "a.mp3");
chk("大小写归一", sandbox.resourceBasename("Assets/Sounds/A.MP3"), "a.mp3");
chk("空值", sandbox.resourceBasename(""), "");
chk("数组摊平", sandbox.itemResourcePaths({ resourcePath: ["a.mp3", "b.mp3"] }), ["a.mp3", "b.mp3"]);
chk("字符串也能吃", sandbox.itemResourcePaths({ resourcePath: "a.mp3" }), ["a.mp3"]);
chk("缺失时为空数组", sandbox.itemResourcePaths({}), []);

console.log("\n--- 商品名/描述以「装点鱼缸配置」为准 ---");
// 1) 商品 resourcePath 是数组，靠文件名关联
const byFile = [
  { id: "sound001", category: "sounds", name: "玩家写的名字", description: "玩家写的描述", price: 25, isMemberOnly: false, resourcePath: ["assets/sounds/water-ambient.mp3"] }
];
sandbox = buildSandbox(audioConfig, byFile);
let items = sandbox.serverSoundItems();
chk("只保留背景分类且可用且有文件的音效", items.map(item => item.id), ["water-ambient", "ocean"]);
chk("名称用商品里的", items[0].name, "玩家写的名字");
chk("描述用商品里的（不再被占位文案顶掉）", items[0].description, "玩家写的描述");
chk("价格用商品里的", items[0].price, 25);
chk("resourcePath 用音效里的真实文件", items[0].resourcePath, "assets/sounds/water-ambient.mp3");
chk("商店分类固定为 sounds", items[0].category, "sounds");

// 2) 同 id 关联，即使文件路径写法完全不同
const byId = [
  { id: "ocean", category: "sounds", name: "海浪（商品）", description: "商品侧描述", price: 40, isMemberOnly: true, resourcePath: ["/somewhere/else/completely-different.mp3"] }
];
sandbox = buildSandbox(audioConfig, byId);
items = sandbox.serverSoundItems();
const ocean = items.find(item => item.id === "ocean");
chk("同 id 关联成功", ocean.name, "海浪（商品）");
chk("同 id 关联时描述也取商品侧", ocean.description, "商品侧描述");
chk("会员标记取商品侧", ocean.isMemberOnly, true);
chk("未匹配到的音效仍用音效名兜底", items.find(item => item.id === "water-ambient").name, "后台填的名字");

// 3) 路径写法不同（/uploads/... vs 只给文件名）也要能命中
const loosePath = [
  { id: "sound002", category: "sounds", name: "松散匹配", description: "路径写法不同", price: 0, resourcePath: ["1790-ocean-waves.mp3"] }
];
sandbox = buildSandbox(audioConfig, loosePath);
items = sandbox.serverSoundItems();
chk("按文件名匹配（忽略目录）", items.find(item => item.id === "ocean").name, "松散匹配");

// 4) 商品存在但描述留空 → 保持为空，不再塞占位文案
const emptyDesc = [
  { id: "water-ambient", category: "sounds", name: "只有名字", description: "", price: 0, resourcePath: [] }
];
sandbox = buildSandbox(audioConfig, emptyDesc);
items = sandbox.serverSoundItems();
chk("商品描述为空时保持为空", items.find(item => item.id === "water-ambient").description, "");

// 5) 完全匹配不到的商品 → 才用音效名 + 占位描述
sandbox = buildSandbox(audioConfig, []);
items = sandbox.serverSoundItems();
chk("匹配不到时用音效名", items[0].name, "后台填的名字");
chk("匹配不到时才用占位描述", items[0].description, "来自后台音频配置的背景音");
chk("匹配不到时按免费处理", items[0].price, 0);

// 6) 非 sounds 分类的商品不参与关联（避免误命中）
const wrongCategory = [
  { id: "water-ambient", category: "fish", name: "一条鱼", description: "不是音效", price: 99, resourcePath: ["assets/sounds/water-ambient.mp3"] }
];
sandbox = buildSandbox(audioConfig, wrongCategory);
items = sandbox.serverSoundItems();
chk("非 sounds 分类商品不参与关联", items.find(item => item.id === "water-ambient").name, "后台填的名字");

// 7) 配置缺失时不炸
sandbox = buildSandbox(null, []);
chk("无音频配置时返回空数组", sandbox.serverSoundItems(), []);
chk("无音频配置时 ambient 仍取 bgm", sandbox.ambientCategoryKey(), "bgm");

console.log("\n--- 商品列表排序（同类型内按 id）---");
// 锁的 bug：之前 CloudBase RDB 默认顺序没保证，用户改一条商品后它会飘到末尾。
// 现在前后端都走 sortShopItems。下面这些 fixture 都没带 category，走的是"同类型内按 id"那一段；
// 类型分组的完整规则（顺序 = 标签栏顺序、认不出的类型沉底）在 shop-sort.test.js。
chk("按 id 排序", sandbox.sortShopItems([
  { id: "fish003" }, { id: "fish001" }, { id: "fish002" }
]).map(item => item.id), ["fish001", "fish002", "fish003"]);
chk("原本就按 id 顺序时不变", sandbox.sortShopItems([
  { id: "fish001" }, { id: "fish002" }, { id: "fish003" }
]).map(item => item.id), ["fish001", "fish002", "fish003"]);
chk("字母开头的混排也能排好", sandbox.sortShopItems([
  { id: "sand001" }, { id: "background002" }, { id: "fish001" }, { id: "decoration003" }
]).map(item => item.id), ["background002", "decoration003", "fish001", "sand001"]);
chk("不会改原数组", sandbox.sortShopItems([
  { id: "fish002" }, { id: "fish001" }
]).map(item => item.id), ["fish001", "fish002"]);
chk("空数组安全", sandbox.sortShopItems([]), []);
chk("缺 id 兜底成空串", sandbox.sortShopItems([{ id: "fish002" }, { name: "no-id" }, { id: "fish001" }]).map(item => item.id), ["fish001", "fish002", undefined]);

console.log("\n--- audioCategory 透传（Bug 6 关联）---");
// 旧代码 serverSoundItems 产出的商品只有 category="sounds"，导致 ambientSoundCategory
// 永远拿不到真实的 bgm/prompt/sfx，调音量面板和分类开关就对不上。当前多留了一个
// audioCategory 字段专门给 ambientSoundCategory 用。
const bgmAudioConfig = {
  categories: { bgm: { label: "背景白噪音", enabled: true, volume: 38 } },
  sounds: [{ id: "water-ambient", name: "海水白噪音", category: "bgm", enabled: true, volume: 100, resourcePath: "assets/sounds/water-ambient.mp3" }]
};
sandbox = buildSandbox(bgmAudioConfig, []);
chk("bgm 分类的音效产物上 audioCategory 字段保留 bgm", sandbox.serverSoundItems()[0].audioCategory, "bgm");
chk("音频产物上 category 仍为商店分类 sounds", sandbox.serverSoundItems()[0].category, "sounds");

console.log("\n----");
console.log(`shop-sound-items.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
