// 结算结果必须真的写回 focus_records —— 线上 bug 的回归测试。
//
// 线上现象（2026-10-06）：专注 23 分钟、泡泡正常到账，但时长统计不涨 ——
// 玩家端显示「今日专注 6 次 · 0 分钟」「累计 13 次 · 6 分钟」。
//
// 根因：结算分两步 ——
//   ① claimFocusSession 抢会话（CAS）：把 settled_at 从 0 改成哨兵值，防重放；
//   ② settleFocusRecord 补写：把 counted_minutes / reward / natural / 真实 settled_at 写进去。
// 云版 ① 的哨兵用的是 now()（**正数**），而 ② 用 `settled_at > 0` 判「已经结算过」→
// ② 看到 ① 刚写的正数哨兵，认定「重复结算」，直接 return，什么都不写。
// 结果：次数 +1（settled_at 非 0 就算已结算），时长 +0（counted_minutes 一直是 0）。
//
// 内存版的哨兵是 -1（负数），② 的 `> 0` 判据不会命中 → 一直是好的。
// 两个 store 行为漂移，而单测只覆盖内存版 —— 这就是它一直没被发现的原因。
//
// 运行：node test/focus-settle-writeback.test.js
import { createMemoryPlayerStore, createCloudbasePlayerStore } from "../player-store.js";
import { createFocusSessionStore } from "../focus-session.js";

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
function chkTrue(name, condition, extra = "") {
  if (condition === true) { console.log(`PASS | ${name}${extra ? " :: " + extra : ""}`); pass++; }
  else { console.log(`FAIL | ${name}${extra ? " :: " + extra : ""}`); fail++; }
}

const TIERS = [
  { endMinute: 25, normalBubblePerMinute: 1, memberBubblePerMinute: 2 },
  { endMinute: 60, normalBubblePerMinute: 2, memberBubblePerMinute: 3 },
  { endMinute: 120, normalBubblePerMinute: 3, memberBubblePerMinute: 5 }
];
const CFG = { minFocusDuration: 25, maxFocusDuration: 120, rewardTiers: TIERS };

let clock = 1790352260164;

// 最小 CloudBase 桩：够跑结算链路（select / insert / update + eq / limit）。
function makeFocusDb(rows = []) {
  const state = { focus_records: rows.map(row => ({ ...row })) };
  const stub = {
    from(table) {
      let op = null;
      let payload = null;
      let limitN = null;
      const filters = [];
      const hit = row => filters.every(([col, value]) => String(row[col]) === String(value));
      const builder = {
        select() { op = "select"; return builder; },
        insert(list) { op = "insert"; payload = list; return builder; },
        update(patch) { op = "update"; payload = patch; return builder; },
        eq(col, value) { filters.push([col, value]); return builder; },
        limit(n) { limitN = n; return builder; },
        throwOnError() {
          const table_ = state[table] || (state[table] = []);
          if (op === "insert") {
            table_.push(...payload.map(row => ({ ...row })));
            return { data: null };
          }
          if (op === "update") {
            for (const row of table_) if (hit(row)) Object.assign(row, payload);
            return { data: null };
          }
          const found = table_.filter(hit).map(row => ({ ...row }));
          return { data: limitN === null ? found : found.slice(0, limitN) };
        }
      };
      return builder;
    }
  };
  return { stub, state };
}

// 按 server.js 的方式装配：cloud store 当 persistence。
function makeCloud() {
  const { stub, state } = makeFocusDb();
  const store = createCloudbasePlayerStore(stub, { now: () => clock });
  const sessions = createFocusSessionStore({
    now: () => clock,
    persistence: {
      findSession: id => store.findFocusSession(id),
      consumeSession: id => store.claimFocusSession(id),
      settleSession: (id, patch) => store.settleFocusRecord(id, patch)
    }
  });
  return { store, sessions, state };
}

// start 时落一行未结算记录（与 server.js 的 focus/start 一致）。
const seedSession = async (store, sessions, uid = "u1") => {
  const session = sessions.start({ plannedMinutes: 25, isMember: false, uid });
  await store.addFocusRecord({
    id: session.sessionId, user_id: uid, planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: session.startedAt, settled_at: 0
  });
  return session;
};

// ===== 1. 抢会话的哨兵必须是负数 =====
console.log("--- 1. 抢会话（CAS）的哨兵必须是负数 ---");
{
  const { store, state } = makeCloud();
  await store.addFocusRecord({
    id: "s1", user_id: "u1", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: clock - 23 * 60000, settled_at: 0
  });

  chk("认领成功", await store.claimFocusSession("s1"), true);
  const sentinel = Number(state.focus_records[0].settled_at);
  chkTrue("🔴 哨兵是负数（正数会被 settleFocusRecord 的 `>0` 判成已结算 → 补写被跳过）",
    sentinel < 0, `settled_at=${sentinel}`);

  await store.settleFocusRecord("s1", { countedMinutes: 23, reward: 23, natural: 0, settledAt: clock });
  chk("🔴 补写后 counted_minutes 到位", Number(state.focus_records[0].counted_minutes), 23);
  chk("补写后 reward 到位", Number(state.focus_records[0].reward), 23);
  chk("补写后 settled_at 是真实结算时间（正数）", Number(state.focus_records[0].settled_at), clock);
}

// ===== 2. 端到端：专注 23 分钟 → 统计必须看到时长 =====
console.log("\n--- 2. 端到端：专注 23 分钟结算后，统计必须看到时长 ---");
{
  const { store, sessions } = makeCloud();
  const session = await seedSession(store, sessions);

  clock = session.startedAt + 23 * 60000;   // 专注 23 分钟后结算
  const result = await sessions.settle(session.sessionId, CFG, { uid: "u1" });
  chk("结算算出 23 分钟", result.countedMinutes, 23);
  chk("结算算出 23 泡泡", result.reward, 23);

  const stats = await store.stats("u1");
  chk("🔴 今日时长 = 23（线上这里恒为 0）", stats.focusMinutesToday, 23);
  chk("🔴 累计时长 = 23（线上这里恒为 0）", stats.focusMinutesTotal, 23);
  chk("今日次数 = 1", stats.focusCountToday, 1);
  chk("累计次数 = 1", stats.focusCount, 1);
  chkTrue("泡泡收入也记下了", stats.bubblesEarned > 0, `bubblesEarned=${stats.bubblesEarned}`);
}

// ===== 3. 两个 store 的哨兵语义必须一致（内存版是参照）=====
console.log("\n--- 3. 内存版与云版行为一致（哨兵都是负数、补写都生效）---");
{
  const memory = createMemoryPlayerStore({ now: () => clock });
  await memory.addFocusRecord({
    id: "m1", user_id: "u1", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: clock, settled_at: 0
  });
  chk("内存版认领成功", await memory.claimFocusSession("m1"), true);
  const claimed = await memory.findFocusSession("m1");
  chkTrue("内存版哨兵也是负数", Number(claimed.settled_at) < 0, `settled_at=${claimed.settled_at}`);

  await memory.settleFocusRecord("m1", { countedMinutes: 25, reward: 25, natural: 1, settledAt: clock });
  const done = await memory.findFocusSession("m1");
  chk("内存版补写也到位", Number(done.counted_minutes), 25);

  // 哨兵残留（认领了但没补写）不能算进统计 —— 两个 store 都要这样。
  const pending = createMemoryPlayerStore({ now: () => clock });
  await pending.addFocusRecord({
    id: "m2", user_id: "u2", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: clock, settled_at: 0
  });
  await pending.claimFocusSession("m2");
  chk("内存版：只有负数哨兵的行不计入统计", (await pending.stats("u2")).focusCount, 0);
}

// ===== 4. 反向：修完不能把防重放弄丢 =====
console.log("\n--- 4. 反向：修完不能把防重放弄丢 ---");
{
  const { store, sessions } = makeCloud();
  const session = await seedSession(store, sessions);

  clock = session.startedAt + 25 * 60000;
  const first = await sessions.settle(session.sessionId, CFG, { uid: "u1" });
  chk("第一次结算成功", first && first.countedMinutes, 25);

  const second = await sessions.settle(session.sessionId, CFG, { uid: "u1" });
  chk("🔴 第二次结算返回 null（同一个 sessionId 不能重复发奖）", second, null);

  const stats = await store.stats("u1");
  chk("统计只算一次", stats.focusCount, 1);
  chk("时长也只算一次", stats.focusMinutesTotal, 25);
}

// ===== 5. 静态锚：云版不能再退回「正数哨兵」=====
console.log("\n--- 5. 静态锚：云版 claimFocusSession 的哨兵必须带负号 ---");
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "..", "player-store.js"), "utf8");

  chkTrue("🔴 云版哨兵写作 -now()（负号不能少）",
    /const claimedAt = -now\(\);/.test(source));
  chkTrue("旧的 now() 正数哨兵已消失",
    !/哨兵值用当前时间/.test(source));
  // 两处 settleFocusRecord 的判据都必须是 `> 0`（负数哨兵要能穿过去）。
  const guards = [...source.matchAll(/settled_at\)\s*>\s*0\)/g)].length;
  chkTrue("两个 store 的 settleFocusRecord 都用 `> 0` 判据", guards >= 2, `命中 ${guards} 处`);
}

console.log(`\n===== 结算写回测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
