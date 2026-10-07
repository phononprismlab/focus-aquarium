// B2 回归测试：种子数据迁移（补齐新项/新字段，不覆盖用户编辑，单例配置随版本更新，幂等）
// B15 回归测试：种子里的假预览图路径（一并放在这里，都是种子数据的约束）
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySeedDefault, planSeedMigration } from "../repository.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoSource = fs.readFileSync(path.join(here, "..", "repository.js"), "utf8");
const gameDataSource = fs.readFileSync(path.join(here, "..", "..", "game-data.js"), "utf8");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS | ${name}`); }
  catch (e) { failed++; console.log(`FAIL | ${name} -> ${e.message}`); }
}

// 单例配置（focus/audio/about/ops）：一律**以库里的值为准**（即后台保存的那份）。
// seed 只负责「库里没有时给初值」+「补齐 seed 新加的字段」。
// 🔴 反向约束：曾经是 seed 无条件覆盖，导致后台改完文案、下次部署被冲回去。
test("单例(focus) 以库里的值为准，不被 seed 覆盖", () => {
  const stored = { minFocusDuration: 25, maxFocusDuration: 120, rewardTiers: [{ id: "tier-1", endMinute: 25 }] };
  const seed = { minFocusDuration: 30, maxFocusDuration: 120, rewardTiers: [{ id: "tier-1", endMinute: 30 }] };
  const out = applySeedDefault("focus", stored, seed);
  assert.strictEqual(out.minFocusDuration, 25, "后台改过的值必须保留");
  assert.deepStrictEqual(out.rewardTiers, stored.rewardTiers, "数组（内容）以库里的为准");
});

test("单例(focus) 库里为空/缺字段时才用 seed", () => {
  const seed = { minFocusDuration: 30, maxFocusDuration: 120 };
  assert.deepStrictEqual(applySeedDefault("focus", {}, seed), seed, "空库用 seed");
  assert.deepStrictEqual(applySeedDefault("focus", null, seed), seed, "无记录用 seed");
  const partial = applySeedDefault("focus", { minFocusDuration: 25 }, seed);
  assert.strictEqual(partial.minFocusDuration, 25, "已有的值保留");
  assert.strictEqual(partial.maxFocusDuration, 120, "seed 新字段补齐");
});

test("单例(about) section 一层合并：后台改的 section 保留，缺的 section 补上", () => {
  const stored = {
    terms: { title: "我的协议", bodyHtml: "<p>后台改的</p>" },
    story: { title: "品牌故事", bodyHtml: "<p>后台改的故事</p>" }
  };
  const seed = {
    terms: { title: "用户协议", bodyHtml: "<p>seed</p>" },
    privacy: { title: "隐私政策", bodyHtml: "<p>seed</p>" },
    story: { title: "品牌故事", bodyHtml: "<p>seed</p>" },
    tip: { title: "打赏支持", bodyHtml: "<p>seed</p>", imageUrl: "" }
  };
  const out = applySeedDefault("about", stored, seed);
  assert.strictEqual(out.terms.bodyHtml, "<p>后台改的</p>", "后台改的正文保留");
  assert.strictEqual(out.story.bodyHtml, "<p>后台改的故事</p>", "后台改的 section 保留");
  assert.strictEqual(out.privacy.title, "隐私政策", "库里缺的 section 由 seed 补上");
  assert.strictEqual(out.tip.imageUrl, "", "seed 新字段补齐");
});

test("单例(audio) categories 深合并、sounds 数组以库里为准", () => {
  const stored = { categories: { bgm: { label: "背景", enabled: false, volume: 10 } }, sounds: [{ id: "s1", name: "后台改过的音效" }] };
  const seed = {
    categories: { bgm: { label: "背景白噪音", enabled: true, volume: 38 }, prompt: { label: "提示音", enabled: true, volume: 100 } },
    sounds: [{ id: "seed-sound" }]
  };
  const out = applySeedDefault("audio", stored, seed);
  assert.strictEqual(out.categories.bgm.volume, 10, "后台改过的音量保留");
  assert.strictEqual(out.categories.bgm.label, "背景", "后台改过的分类名保留");
  assert.strictEqual(out.categories.bgm.enabled, false, "后台关掉的分类保持关闭");
  assert.strictEqual(out.categories.prompt.label, "提示音", "库里缺的分类由 seed 补上");
  assert.deepStrictEqual(out.sounds, stored.sounds, "音效列表以库里的为准");
});

test("单例(ops) 停机状态与通知跨重启保留", () => {
  const stored = { maintenance: true, maintenanceMessage: "维护中", notice: { id: "n1", title: "今晚维护", active: true } };
  const seed = {
    maintenance: false, maintenanceMessage: "", maintenanceEta: "", maintenanceAllowUids: [],
    notice: { id: "", level: "info", title: "", body: "", startAt: 0, endAt: 0, ctaText: "", ctaUrl: "", active: false }
  };
  const out = applySeedDefault("ops", stored, seed);
  assert.strictEqual(out.maintenance, true, "停机状态不被冲掉");
  assert.strictEqual(out.notice.title, "今晚维护", "通知内容保留");
  assert.deepStrictEqual(out.maintenanceAllowUids, [], "seed 新字段补齐");
});

// 用户内容：保留用户已改字段，补齐 seed 新增字段
test("用户内容保留用户改过的 price，补齐新字段 color", () => {
  const seed = { id: "fish001", name: "小丑鱼", price: 30, color: "orange" };
  const stored = { id: "fish001", name: "小丑鱼", price: 99 }; // 用户改了 price，尚未有 color
  const out = applySeedDefault("decorations", stored, seed);
  assert.strictEqual(out.price, 99, "用户改过的 price 必须保留");
  assert.strictEqual(out.color, "orange", "seed 新增字段应补齐");
  assert.strictEqual(out.name, "小丑鱼");
});

// plan: 新 id -> insert
test("plan: 新商品 id 应 insert", () => {
  const plan = planSeedMigration("decorations", [{ id: "new1", price: 10 }], []);
  assert.strictEqual(plan[0].action, "insert");
});

// plan: 用户改过 -> skip（不覆盖）
test("plan: 用户改过的内容应 skip（不覆盖）", () => {
  const seed = { id: "d1", price: 30 };
  const existingRows = [{ id: "d1", data: { id: "d1", price: 99 }, publishedData: { id: "d1", price: 99 }, rowId: 7 }];
  const plan = planSeedMigration("decorations", [seed], existingRows);
  assert.strictEqual(plan[0].action, "skip");
});

// plan: 缺失新字段 -> update
test("plan: 缺失新字段应 update 且补齐", () => {
  const seed = { id: "d1", price: 30, color: "red" };
  const existingRows = [{ id: "d1", data: { id: "d1", price: 30 }, publishedData: { id: "d1", price: 30 }, rowId: 7 }];
  const plan = planSeedMigration("decorations", [seed], existingRows);
  assert.strictEqual(plan[0].action, "update");
  assert.strictEqual(plan[0].data.color, "red");
  assert.strictEqual(plan[0].data.price, 30);
});

// F9：老数据缺 tags 字段 -> update 且补成空数组（不覆盖用户已有 tags）
test("plan: 老数据缺失的 tags 字段应被补齐", () => {
  const seed = { id: "d1", name: "x", tags: [] };
  const existingRows = [{ id: "d1", data: { id: "d1", name: "x" }, publishedData: { id: "d1", name: "x" }, rowId: 7 }];
  const plan = planSeedMigration("decorations", [seed], existingRows);
  assert.strictEqual(plan[0].action, "update");
  assert.deepStrictEqual(plan[0].data.tags, []);
});

test("plan: 用户已有 tags 时不被 seed 覆盖", () => {
  const seed = { id: "d1", name: "x", tags: [] };
  const existingRows = [{ id: "d1", data: { id: "d1", name: "x", tags: ["新品"] }, publishedData: { id: "d1", name: "x", tags: ["新品"] }, rowId: 7 }];
  const plan = planSeedMigration("decorations", [seed], existingRows);
  assert.strictEqual(plan[0].action, "skip");
});

// B15：种子里的假预览图路径
test("B15: seed 里不再有假 previewImage 路径", () => {
  assert.strictEqual((repoSource.match(/previewImage: "assets\//g) || []).length, 0);
  assert.strictEqual((repoSource.match(/previewImage: ""/g) || []).length, 13);
});

test("B15: game-data.js 里不再有假 previewImage 路径", () => {
  assert.strictEqual((gameDataSource.match(/previewImage:"assets\//g) || []).length, 0);
});

test("B15: 老库里的假 previewImage 视为未设置（被清空）", () => {
  const seed = { id: "d1", name: "x", previewImage: "" };
  const stored = { id: "d1", name: "x", previewImage: "assets/plants/plant001_preview.webp" };
  const out = applySeedDefault("decorations", stored, seed);
  assert.strictEqual(out.previewImage, "");
  assert.strictEqual(out.name, "x", "其它字段照常保留");
});

test("B15: 用户真上传的图不会被清掉", () => {
  const seed = { id: "d1", name: "x", previewImage: "" };
  const uploaded = "images/1758500000000-ab12cd-我的图.png";
  const out = applySeedDefault("decorations", { id: "d1", name: "x", previewImage: uploaded }, seed);
  assert.strictEqual(out.previewImage, uploaded);
});

test("B15: 老库假路径会被规划成 update（把死链清掉）", () => {
  const seed = { id: "d1", name: "x", previewImage: "" };
  const existingRows = [{ id: "d1", data: { id: "d1", name: "x", previewImage: "assets/fish/fish001_preview.webp" }, publishedData: { id: "d1", name: "x", previewImage: "assets/fish/fish001_preview.webp" }, rowId: 7 }];
  const plan = planSeedMigration("decorations", [seed], existingRows);
  assert.strictEqual(plan[0].action, "update");
  assert.strictEqual(plan[0].data.previewImage, "");
  assert.strictEqual(plan[0].publishedData.previewImage, "");
});

// plan: 单例与 seed 不同 -> skip（后台的值说了算，启动时一次写都不该发生）
test("plan: 单例与 seed 不一致时 skip（不覆盖后台配置）", () => {
  const seed = { minFocusDuration: 30 };
  const existingRows = [{ id: "focus", data: { minFocusDuration: 25 }, publishedData: { minFocusDuration: 25 }, rowId: 3 }];
  const plan = planSeedMigration("focus", [seed], existingRows);
  assert.strictEqual(plan[0].action, "skip");
});

// plan: 单例缺 seed 新加的字段 -> update 且只补缺的那部分
test("plan: 单例缺 seed 新字段 -> update 只补字段、不动已有值", () => {
  const seed = { minFocusDuration: 30, maxFocusDuration: 120 };
  const existingRows = [{ id: "focus", data: { minFocusDuration: 25 }, publishedData: { minFocusDuration: 25 }, rowId: 3 }];
  const plan = planSeedMigration("focus", [seed], existingRows);
  assert.strictEqual(plan[0].action, "update");
  assert.strictEqual(plan[0].data.minFocusDuration, 25, "库里的值保留");
  assert.strictEqual(plan[0].data.maxFocusDuration, 120, "seed 新字段补齐");
});

// 幂等性：update 结果再跑一次 plan -> 全 skip
test("幂等：update 后再 plan 应全 skip", () => {
  const seed = { id: "d1", price: 30, color: "red" };
  const existingRows = [{ id: "d1", data: { id: "d1", price: 30 }, publishedData: { id: "d1", price: 30 }, rowId: 7 }];
  const plan1 = planSeedMigration("decorations", [seed], existingRows);
  assert.strictEqual(plan1[0].action, "update");
  const afterRows = [{ id: "d1", data: plan1[0].data, publishedData: plan1[0].publishedData, rowId: 7 }];
  const plan2 = planSeedMigration("decorations", [seed], afterRows);
  assert.strictEqual(plan2[0].action, "skip", "二次运行必须幂等");
});

console.log(`\nseed-migration.test: PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
