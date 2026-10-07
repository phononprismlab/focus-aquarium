// 后台的「删除」= 下架，不是真删。这是「删掉的默认项被种子迁移复活」的唯一解。
//
// 为什么要下架（问题的完整链条）：
//   1. runSeedMigration 判断某个默认项该不该补，**唯一依据**是「库里有没有这个 config_id」
//      （见 planSeedMigration：没有 → insert，有 → skip/update，没有第三种状态）；
//   2. 原来的 remove() 是物理删除那一行；
//   3. 于是「后台删掉的默认项」在迁移眼里等于「从来没建过」→ 下次启动 insert 补回来 →
//      后台删了又回来，玩家端也跟着重新看到。
//   4. 要防复活，行就**必须留着**。所以 remove() 改成 published=false + published_data=null：
//      玩家端（按 published===true 过滤）立刻看不到，后台列表（不筛 published）仍看得到，
//      迁移看到 id 还在 → 不会 insert。
//
// 本文件锁四件事：
//   1) 内存仓库 remove() 是下架语义（行还在、published=false、publishedData=null、幂等）；
//   2) planSeedMigration 对「线上没有版本」的行保持 publishedData=null，不会偷偷填一份；
//   3) 云端仓库 remove() 发的是 update 而不是 delete（行不会被抹掉）；
//   4) 端到端：下架 → 玩家端看不到 → **再跑一遍种子迁移也不复活** → 上架后恢复。
//
// 反向验证：把 repository.js 的 remove() 改回 `delete()`，第 1/3/4 段会 FAIL；
//          把 planSeedMigration 的 `: null` 改回 `: newData`，第 2 段与第 4 段会 FAIL。
//
// 跑法：node api/test/config-unpublish.test.js（或 npm test 从仓库根跑）
import { createMemoryRepository, createCloudbaseRepository, setRdbForTest, planSeedMigration, runSeedMigration } from "../repository.js";

let pass = 0, fail = 0;
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

// 假 RDB：记录有没有发过 delete，并把 update / insert / select 落进内存 rows。
function makeFakeRdb() {
  const rows = [];
  const calls = { deletes: 0, updates: 0, inserts: 0 };
  const from = () => {
    const eqs = {};
    let op = null;
    const chain = {
      select() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      eq(col, val) { eqs[col] = val; return chain; },
      insert(payload) { op = { kind: "insert", payload }; return chain; },
      update(obj) { op = { kind: "update", obj }; return chain; },
      delete() { calls.deletes += 1; op = { kind: "delete" }; return chain; },
      async throwOnError() {
        if (op && op.kind === "insert") {
          calls.inserts += 1;
          for (const p of op.payload) rows.push({ id: String(rows.length + 1), ...p });
          return { data: op.payload };
        }
        if (op && op.kind === "update") {
          calls.updates += 1;
          const i = rows.findIndex(r => r.id === eqs.id);
          if (i >= 0) rows[i] = { ...rows[i], ...op.obj };
          return { data: i >= 0 ? [rows[i]] : [] };
        }
        if (op && op.kind === "delete") {
          const i = rows.findIndex(r => r.id === eqs.id);
          if (i >= 0) rows.splice(i, 1);
          return { data: [] };
        }
        let data = rows;
        if (eqs.type !== undefined) data = data.filter(r => r.type === eqs.type);
        if (eqs.config_id !== undefined) data = data.filter(r => r.config_id === eqs.config_id);
        if (eqs.id !== undefined) data = data.filter(r => r.id === eqs.id);
        if (eqs.published !== undefined) data = data.filter(r => r.published === eqs.published);
        return { data: data.map(r => ({ ...r })) };
      }
    };
    return chain;
  };
  return { rdb: { from }, rows, calls };
}

console.log("--- 1. 内存仓库：remove() = 下架，不是真删 ---");
{
  const repo = createMemoryRepository();
  const totalBefore = (await repo.list("decorations", false)).length;
  const visibleBefore = (await repo.list("decorations", true)).length;
  chkTrue("初始默认装饰已全部发布", totalBefore > 0 && visibleBefore === totalBefore, `total=${totalBefore} visible=${visibleBefore}`);

  await repo.remove("decorations", "decoration001");

  const all = await repo.list("decorations", false);
  const record = all.find(r => r.id === "decoration001");
  chk("下架后后台仍查得到这一条（行没有被抹掉）", Boolean(record), true);
  chk("下架后 published=false", record && record.published, false);
  chk("下架后 publishedData=null（线上没有这一份）", record && record.publishedData, null);
  chk("下架后行数不变", all.length, totalBefore);
  chk("下架后玩家端看不到它", (await repo.list("decorations", true)).some(r => r.id === "decoration001"), false);
  chk("下架后玩家端可见条数 -1", (await repo.list("decorations", true)).length, visibleBefore - 1);

  // 幂等：重复下架、下架不存在的 id 都不该报错，也不该凭空多出行
  await repo.remove("decorations", "decoration001");
  await repo.remove("decorations", "不存在的-id");
  chk("重复下架 / 下架不存在的 id 都不产生新行", (await repo.list("decorations", false)).length, totalBefore);

  // 上架：publish 走的是同一套（published=true + publishedData=data）
  await repo.publish("decorations", "decoration001");
  chk("上架后玩家端又能看到", (await repo.list("decorations", true)).some(r => r.id === "decoration001"), true);
}

console.log("\n--- 2. planSeedMigration：已下架的行不能被打回「已发布」 ---");
{
  const seedValue = { id: "d1", name: "水草", price: 20 };
  const retiredRow = { id: "d1", data: { id: "d1", name: "水草", price: 20 }, publishedData: null, rowId: 7 };

  const same = planSeedMigration("decorations", [seedValue], [retiredRow]);
  chk("已下架 + 内容没变 -> skip（一个字节都不写）", same[0].action, "skip");

  const grown = planSeedMigration("decorations", [{ ...seedValue, tags: [] }], [retiredRow]);
  chk("已下架 + seed 加了新字段 -> update（新字段仍要下发到草稿）", grown[0].action, "update");
  chk("update 时 publishedData 保持 null（不偷偷填一份线上数据）", grown[0].publishedData, null);
  chk("update 时 data 确实补上了新字段", grown[0].data.tags, []);

  // 反向对照：没下架的行（publishedData 非 null）照旧会更新线上那一份
  const liveRow = { id: "d1", data: { id: "d1", name: "水草", price: 20 }, publishedData: { id: "d1", name: "水草", price: 20 }, rowId: 7 };
  const livePlan = planSeedMigration("decorations", [{ ...seedValue, tags: [] }], [liveRow]);
  chk("没下架的行仍然会更新 publishedData", livePlan[0].publishedData && livePlan[0].publishedData.tags, []);
}

console.log("\n--- 3. 云端仓库：remove() 走 update，不发 delete ---");
{
  const fake = makeFakeRdb();
  setRdbForTest(fake.rdb);
  const repo = await createCloudbaseRepository();
  const totalBefore = fake.rows.length;
  chkTrue("种子迁移已把默认集写进库", totalBefore > 0, `rows=${totalBefore}`);
  chkTrue("迁移用的是 insert（不是 update）", fake.calls.inserts > 0 && fake.calls.updates === 0, `inserts=${fake.calls.inserts} updates=${fake.calls.updates}`);

  const deletesBefore = fake.calls.deletes;
  await repo.remove("decorations", "decoration001");
  chk("remove() 一次 delete 都没发（真删 = 默认项下次启动复活）", fake.calls.deletes - deletesBefore, 0);

  const row = fake.rows.find(r => r.type === "decorations" && r.config_id === "decoration001");
  chkTrue("那一行还在库里", Boolean(row));
  chk("published 被关掉", row && row.published, false);
  chk("published_data 被清空", row && row.published_data, null);
  chk("总行数没有减少", fake.rows.length, totalBefore);
  chk("后台仍能看到（list(type,false) 不筛 published）", (await repo.list("decorations", false)).some(r => r.id === "decoration001"), true);
  chk("玩家端看不到（list(type,true) 筛 published===true）", (await repo.list("decorations", true)).some(r => r.id === "decoration001"), false);

  // 🔴 最关键的一段：再跑一遍种子迁移。这一步就是「部署一次」的等价动作。
  //    人为让草稿缺一个 seed 字段，逼迁移走 update 分支（否则它会 skip，测不到写库路径）。
  const decorationsBefore = fake.rows.filter(r => r.type === "decorations").length;
  // 迁移 insert 时写进去的，就是 seed 的值（别在这里硬编码）。
  // 取的时候要防住「行已经被删掉」—— 那正是反向验证时会发生的情况，
  // 直接 row.data 会抛 TypeError，把一条清晰的 FAIL 变成一坨堆栈。
  const seedTags = row && row.data ? row.data.tags : null;
  if (row && row.data) delete row.data.tags;
  await runSeedMigration(fake.rdb, "fishtank_configs");
  const afterMigration = fake.rows.find(r => r.type === "decorations" && r.config_id === "decoration001");
  chkTrue("迁移跑过之后行还在（没被删、也没被复制出一行新的）", Boolean(afterMigration));
  chk("迁移不会把它重新发布", afterMigration && afterMigration.published, false);
  chk("迁移不会给已下架的行填回线上数据", afterMigration && afterMigration.published_data, null);
  chk("迁移仍然把 seed 新字段补进草稿（下架不等于冻结）", afterMigration && afterMigration.data.tags, seedTags);
  chk("迁移后玩家端仍然看不到", (await repo.list("decorations", true)).some(r => r.id === "decoration001"), false);
  chk("迁移后 decorations 总行数没变（没有 insert 复活）", fake.rows.filter(r => r.type === "decorations").length, decorationsBefore);

  // 上架：调 publish 就该恢复
  await repo.publish("decorations", "decoration001");
  chk("上架后玩家端又能看到", (await repo.list("decorations", true)).some(r => r.id === "decoration001"), true);
  setRdbForTest(null);
}

console.log(`\n===== config-unpublish.test: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail ? 1 : 0);
