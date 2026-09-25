// schema.sql 必须和代码用到的表/列保持一致。
//
// 为什么需要这个闸：
//   这 4 张表原来只写在交付文档里、靠人在控制台手工建。代码加一列、线上没加，
//   只有跑到那条 SQL 才会 500 —— 而且玩家端表现为「云存档偶尔失败」，很难定位。
//   现在 schema.sql 是唯一权威，这个测试盯着它别和代码走偏。
// 运行：node test/schema.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const read = name => fs.readFileSync(path.join(apiDir, name), "utf8").replace(/\r\n/g, "\n");

const schema = read("schema.sql");
const store = read("player-store.js");

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

// 解析 CREATE TABLE 块 → { 表名: [列名...] }
function parseSchema(sql) {
  const tables = {};
  const re = /CREATE TABLE IF NOT EXISTS\s+public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const m of sql.matchAll(re)) {
    const cols = m[2]
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("--"))
      .map(line => line.match(/^(\w+)\s+/))
      .filter(Boolean)
      .map(x => x[1])
      .filter(name => !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(name));
    tables[m[1]] = cols;
  }
  return tables;
}
const tables = parseSchema(schema);
// 注释里会为了说明「别写 MySQL 语法」而真的写出 TINYINT / LONGTEXT 这些词，
// 所以查语法禁忌前先把注释剥掉，否则测试被自己的说明文字绊倒。
const schemaNoComments = schema.replace(/^\s*--.*$/gm, "");

console.log("--- 1. 表名与代码里的常量一一对应 ---");
const constants = [...store.matchAll(/export const TABLE_(\w+) = "(\w+)";/g)].map(m => ({ constName: m[1], table: m[2] }));
chk("代码里声明了 4 张表", constants.length, 4);
chk("表名集合与 schema.sql 一致",
  constants.map(c => c.table).sort(),
  Object.keys(tables).sort());
chkTrue("users / saves / focus_records / tracking_events 都在",
  ["users", "saves", "focus_records", "tracking_events"].every(t => t in tables));

console.log("\n--- 2. 列清单锁死（改结构必须是有意的）---");
const EXPECTED = {
  users: ["user_id", "sync_code_hash", "nickname", "cohort", "is_supporter", "supporter_note", "created_at", "last_seen_at"],
  saves: ["user_id", "data", "save_version", "client_ts", "updated_at"],
  focus_records: ["id", "user_id", "planned_minutes", "counted_minutes", "reward", "natural", "started_at", "settled_at"],
  tracking_events: ["id", "user_id", "event", "detail", "at"]
};
for (const [table, cols] of Object.entries(EXPECTED)) {
  chk(`${table} 的列`, (tables[table] || []).slice().sort(), cols.slice().sort());
}

console.log("\n--- 3. 代码里写进去的每个列名都得在 schema.sql 里有 ---");
// 从 PG 实现里抽 insert / update 的参数对象字面量键：
//   const row = { a: 1, b: 2 }        → ensureUser / putSave 的形态
//   insert([{ a: 1, b: 2 }])          → addTrackingEvent 的形态
//   .update({ a: 1 })                 → ensureUser 续期 / updateUser 的形态
function collectColumnKeys(code) {
  const keys = new Set();
  const literals = [
    ...code.matchAll(/const row = \{([\s\S]{0,600}?)\n\s*\};/g),
    ...code.matchAll(/insert\(\[\{([\s\S]{0,600}?)\}\]/g),
    ...code.matchAll(/\.update\(\{([\s\S]{0,600}?)\}\)/g)
  ].map(m => m[1]);
  for (const body of literals) {
    for (const k of body.matchAll(/(?:^|[\s,{])([a-z][a-z0-9_]*)\s*:/g)) keys.add(k[1]);
  }
  return keys;
}
const usedKeys = collectColumnKeys(store);
const declared = new Set(Object.values(tables).flat());
chkTrue("确实抽到了列名（不是空闸）", usedKeys.size >= 12, `${usedKeys.size} 个`);
const missing = [...usedKeys].filter(k => !declared.has(k)).sort();
chk("代码用到但 schema.sql 里没有的列", missing, []);

// 反向：故意从 schema 里挖掉一列，上面那条断言必须变红。
{
  const broken = schema.replace(/\n\s*client_ts\s+bigint[^\n]*\n/, "\n");
  const brokenTables = parseSchema(broken);
  const brokenDeclared = new Set(Object.values(brokenTables).flat());
  chkTrue("反向：删掉 client_ts 后，缺失列会非空（断言不是空闸）",
    [...usedKeys].filter(k => !brokenDeclared.has(k)).includes("client_ts"));
}
{
  // 反向：代码里新加一列而 schema 没跟上 → 必须被抓到。
  const evilStore = store.replace("const row = {\n        user_id: uid,", "const row = {\n        brand_new_column: 1,\n        user_id: uid,");
  chkTrue("反向：代码新增列而 schema 没加 → 报缺失",
    [...collectColumnKeys(evilStore)].filter(k => !declared.has(k)).includes("brand_new_column"));
}

console.log("\n--- 4. 类型与刻意的取舍 ---");
{
  chk("4 张表都声明了主键", (schema.match(/PRIMARY KEY \(/g) || []).length, 4);
  chkTrue("saves.data 是 text（不是 varchar，整包 JSON 会超长）",
    /data\s+text\s+NOT NULL/.test(schema));
  chkTrue("tracking_events.detail 是 text（购买事件要塞 JSON）",
    /detail\s+text\s+NOT NULL/.test(schema));
  chkTrue("tracking_events.id 是 varchar 主键（控制台建不出 bigserial，ID 由应用层生成）",
    /CREATE TABLE IF NOT EXISTS public\.tracking_events[\s\S]*?id\s+varchar\(32\)\s+NOT NULL/.test(schema));
  chkTrue("没有外键（focus_records.user_id 刻意不校验存在性）",
    !/FOREIGN KEY|REFERENCES/i.test(schema));
  // bigint 写成 integer 会直接溢出：毫秒时间戳约 1.7e12，int4 上限 21 亿。
  // 只扫 CREATE TABLE 块内部，别把 CREATE INDEX 的名字（idx_tracking_event_at）算进来。
  const tableBodies = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)\s*\(([\s\S]*?)\n\);/g)];
  const typeOf = {};
  for (const [, , body] of tableBodies) {
    for (const m of body.matchAll(/^\s*(\w+)\s+(\w+)/gm)) typeOf[m[1]] = m[2];
  }
  // 所有存毫秒时间戳的列 —— 一个都不能是 integer。
  const TIME_COLUMNS = ["created_at", "last_seen_at", "client_ts", "updated_at", "started_at", "settled_at", "at"];
  const wrongType = TIME_COLUMNS.filter(col => typeOf[col] !== "bigint");
  chk("毫秒时间戳列全是 bigint", wrongType, []);
  chkTrue("7 个时间列都真的在 schema 里（不是全没匹配上）",
    TIME_COLUMNS.every(col => col in typeOf), TIME_COLUMNS.map(c => `${c}:${typeOf[c] || "缺失"}`).join(" "));
  chkTrue("没有 MySQL 专属语法", !/TINYINT|LONGTEXT|DEFAULT CHARSET|^\s*KEY\s/im.test(schemaNoComments));
  chkTrue("语句是幂等的（IF NOT EXISTS）",
    (schema.match(/CREATE TABLE IF NOT EXISTS/g) || []).length === 4 &&
    (schema.match(/CREATE INDEX IF NOT EXISTS/g) || []).length >= 1);
}

console.log(`\n===== schema.sql 一致性测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
