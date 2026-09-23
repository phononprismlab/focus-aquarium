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

// 单例配置（focus/audio）：直接以最新 seed 为准
test("单例(focus) 用最新 seed 覆盖", () => {
  const stored = { minFocusDuration: 25, maxFocusDuration: 120, rewardTiers: [{ id: "tier-1", endMinute: 25 }] };
  const seed = { minFocusDuration: 30, maxFocusDuration: 120, rewardTiers: [{ id: "tier-1", endMinute: 30 }] };
  assert.deepStrictEqual(applySeedDefault("focus", stored, seed), seed);
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

// plan: 单例有变化 -> update
test("plan: 单例配置变化应 update", () => {
  const seed = { minFocusDuration: 30 };
  const existingRows = [{ id: "focus", data: { minFocusDuration: 25 }, publishedData: { minFocusDuration: 25 }, rowId: 3 }];
  const plan = planSeedMigration("focus", [seed], existingRows);
  assert.strictEqual(plan[0].action, "update");
  assert.strictEqual(plan[0].data.minFocusDuration, 30);
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
