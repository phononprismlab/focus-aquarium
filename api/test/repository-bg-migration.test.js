// 云端配置仓库的**启动路径**：种子迁移必须不挡路，且 7 个 type 的 select 必须并行。
//
// 为什么单独立一个测试：冷启动时「仓库就绪」这一段时间直接决定玩家要盯着加载页多久。
// 迁移原本是「7 个 type 串行 select + 串行写」并挡在启动路径上，一旦 DB 抖动（throwOnError
// 抛错）整个仓库还会被判成初始化失败 → 全站配置接口 500。这两件事都只有靠假 RDB 的
// 时延 + 并发计数才能验，真环境里看不出来（热态下 7 次往返只要 1.4s，冷启动才暴露）。
//
// 锁四件事：
//   1) background=true：仓库立刻可用（不等迁移），迁移在后台跑完并真的落库；
//   2) 迁移的 select 是**并行**发的（并发峰值 > 1）；
//   3) 迁移失败不会拖垮仓库，也不会静默（有日志）；
//   4) 反向：不带 background 时确实会等迁移（证明这个开关不是摆设）。
//
// 运行：node api/test/repository-bg-migration.test.js   （或归入 run-unit.mjs 从仓库根跑）
import { createCloudbaseRepository, setRdbForTest } from "../repository.js";

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 带时延的假 RDB：每次查询挂 delayMs，用来把「串行 vs 并行」放大到可断言的程度。
function makeSlowRdb({ delayMs = 150, failQueries = false } = {}) {
  const rows = [];
  const stats = { queries: 0, inFlight: 0, peak: 0 };
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
      delete() { op = { kind: "delete" }; return chain; },
      async throwOnError() {
        stats.queries += 1;
        stats.inFlight += 1;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        await sleep(delayMs);
        stats.inFlight -= 1;
        if (failQueries) throw new Error("模拟 RDB 抖动");
        if (op && op.kind === "insert") {
          for (const p of op.payload) rows.push({ id: String(rows.length + 1), ...p });
          return { data: op.payload };
        }
        if (op && op.kind === "update") {
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
  return { rdb: { from }, rows, stats };
}

const DELAY = 150;

console.log("--- 1. background=true：仓库立刻可用，迁移在后台补齐默认集 ---");
{
  const fake = makeSlowRdb({ delayMs: DELAY });
  setRdbForTest(fake.rdb);
  const startedAt = Date.now();
  const repo = await createCloudbaseRepository({ background: true });
  const readyMs = Date.now() - startedAt;
  chkTrue("仓库就绪不等迁移（< 一次查询的时延）", readyMs < DELAY, `${readyMs}ms`);
  chkTrue("就绪时迁移还没跑完（库还是空的）", fake.rows.length === 0, `rows=${fake.rows.length}`);

  await sleep(DELAY * 3);
  chkTrue("迁移最终真的落库了（decorations 已插入）", fake.rows.some(r => r.type === "decorations"), `rows=${fake.rows.length}`);
  chkTrue("迁移的查询是并行发的（并发峰值 > 1）", fake.stats.peak > 1, `peak=${fake.stats.peak}`);
  setRdbForTest(null);
}

console.log("\n--- 2. 迁移失败：不拖垮仓库，也不静默 ---");
{
  const fake = makeSlowRdb({ delayMs: 30, failQueries: true });
  setRdbForTest(fake.rdb);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(" ")); };
  let repo = null;
  let threw = false;
  try {
    repo = await createCloudbaseRepository({ background: true });
  } catch (_) {
    threw = true;
  }
  await sleep(200);
  console.error = originalError;
  chkTrue("迁移抛错不会让仓库初始化失败", threw === false);
  chkTrue("仓库对象仍然可用（list/save 都在）", Boolean(repo && typeof repo.list === "function" && typeof repo.save === "function"));
  chkTrue("失败被记进日志（不是静默吞掉）", logged.some(line => line.includes("种子迁移失败")), logged.join(" | ").slice(0, 80));
  setRdbForTest(null);
}

console.log("\n--- 3. 反向：不带 background 时必须等迁移（开关不是摆设）---");
{
  const fake = makeSlowRdb({ delayMs: DELAY });
  setRdbForTest(fake.rdb);
  const startedAt = Date.now();
  await createCloudbaseRepository();
  const waitedMs = Date.now() - startedAt;
  chkTrue("默认（同步）会等满迁移", waitedMs >= DELAY, `${waitedMs}ms`);
  chkTrue("等完之后默认集已在库里", fake.rows.length > 0, `rows=${fake.rows.length}`);
  setRdbForTest(null);
}

console.log(`\n===== repository-bg-migration: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail ? 1 : 0);
