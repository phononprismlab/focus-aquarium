// 「专注到一半关掉网页 → 那一轮白费」的回归测试。
//
// 现象（2026-10-06 dominik 报）：专注状态只活在前端内存里，一不小心关掉标签页就全丢了 ——
// 服务端 focus_records 那一行还挂着「未结算」，但前端再也找不回来。
//
// 修法：前端把进度写进 localStorage，重开页面接着跑（关闭期间**不算**专注），
// 结算时把「有效专注秒数」上报给服务端。
//
// 本文件锁住服务端这一侧的口径 —— 前端那份在 fa-player-ui-verify.mjs 的第 13 节：
//   ① effectiveElapsedMs 只允许**往下夹**（min(上报值, 真实流逝)），谎报大值没有收益；
//   ② 不传 = 老行为（按真实流逝算），保证向后兼容、现有调用方不受影响；
//   ③ 端到端：关了 50 分钟再回来补结算，只按真正专注的 25 分钟算；
//   ④ 内存版 / 云版两个 store 走同一条口径（双 store 漂移是这块的老毛病）。
//
// 运行：node test/focus-resume.test.js
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryPlayerStore, createCloudbasePlayerStore } from "../player-store.js";
import { createFocusSessionStore, settleSession } from "../focus-session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(here, "..", "server.js"), "utf8");

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

const START = 1790352260164;
const min = n => n * 60000;

// ===== 1. settleSession：有效时长只允许往下夹 =====
console.log("--- 1. settleSession：effectiveElapsedMs 只往下夹 ---");
{
  const base = { startedAt: START, plannedMinutes: 25, isMember: false, settledAt: START + min(50), focusConfig: CFG };

  const legacy = settleSession(base);
  chk("不传 → 按真实流逝算（50 分钟，老行为不变）", legacy.elapsedMinutes, 50);
  chk("不传 → 50 分钟自然算完成", legacy.naturalCompletion, true);

  const honest = settleSession({ ...base, effectiveElapsedMs: min(25) });
  chk("🔴 上报 25 分钟（真专注的时长）→ 只算 25 分钟", honest.elapsedMinutes, 25);
  chk("上报 25 分钟 → countedMinutes = 25（不是 50）", honest.countedMinutes, 25);
  chk("上报 25 分钟 → 奖励按 25 分钟算 = 25 泡泡（不是 75）", honest.reward, 25);

  const liar = settleSession({ ...base, effectiveElapsedMs: min(999) });
  chk("🔴 谎报 999 分钟 → 被夹回真实流逝的 50 分钟", liar.elapsedMinutes, 50);

  const zero = settleSession({ ...base, effectiveElapsedMs: 0 });
  chk("上报 0 → 一分钟都不算", zero.countedMinutes, 0);
  chk("上报 0 → 奖励 0", zero.reward, 0);

  const negative = settleSession({ ...base, effectiveElapsedMs: -12345 });
  chk("上报负数 → 夹到 0，不是负数", negative.elapsedMinutes, 0);

  const nullish = settleSession({ ...base, effectiveElapsedMs: null });
  chk("显式传 null → 等同于没传（老行为）", nullish.elapsedMinutes, 50);

  // 边界：上报值大于计划但小于真实流逝 —— 按上报值算，且够自然完成。
  const partial = settleSession({
    startedAt: START, plannedMinutes: 25, isMember: false,
    settledAt: START + min(40), focusConfig: CFG, effectiveElapsedMs: min(30)
  });
  chk("上报 30 分钟（计划 25）→ 算 30 分钟", partial.elapsedMinutes, 30);
  chk("上报 30 分钟 → 自然完成，countedMinutes 封顶在计划值 25", partial.countedMinutes, 25);
}

// ===== 2. 服务端归一化：非法值当没传 =====
console.log("\n--- 2. 服务端归一化 normalizeEffectiveElapsedMs ---");
{
  chkTrue("有归一化函数（秒 → 毫秒，非法值一律当没传）",
    /function normalizeEffectiveElapsedMs\(seconds\)\s*\{/.test(serverSource));
  const body = (serverSource.match(/function normalizeEffectiveElapsedMs\(seconds\)\s*\{([\s\S]*?)\n\}/) || ["", ""])[1];
  chkTrue("用 Number.isFinite 挡 NaN / Infinity / 字符串", /Number\.isFinite\(value\)/.test(body));
  chkTrue("负数当没传（返回 null）", /value < 0\) return null/.test(body));
  chkTrue("换算成毫秒", /value \* 1000/.test(body));
  chkTrue("结算路由把 elapsedSeconds 归一化后传进 settle",
    /effectiveElapsedMs: normalizeEffectiveElapsedMs\(req\.body && req\.body\.elapsedSeconds\)/.test(serverSource));
  // 反向：如果谁把它直接塞进 settle（没夹），谎报就有收益了 —— 这里只保证入口存在。
  chkTrue("settle 内部有 Math.min 往下夹（不是直接用上报值）",
    /Math\.min\(Math\.max\(0, Number\(effectiveElapsedMs\) \|\| 0\), rawElapsedMs\)/.test(
      readFileSync(path.join(here, "..", "focus-session.js"), "utf8")));
}

// ===== 3. 端到端（内存 store）：关了 50 分钟回来补结算 =====
console.log("\n--- 3. 端到端（内存 store）：中途关掉网页 ---");
{
  let clock = START;
  const store = createMemoryPlayerStore({ now: () => clock });
  const sessions = createFocusSessionStore({
    now: () => clock,
    persistence: {
      findSession: id => store.findFocusSession(id),
      consumeSession: id => store.claimFocusSession(id),
      settleSession: (id, patch) => store.settleFocusRecord(id, patch)
    }
  });

  const session = sessions.start({ plannedMinutes: 25, isMember: false, uid: "u1" });
  await store.addFocusRecord({
    id: session.sessionId, user_id: "u1", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: session.startedAt, settled_at: 0
  });

  // 专注 25 分钟（页面跑到一半被关掉），之后 50 分钟才回来 → 补结算时上报 25 分钟。
  clock = session.startedAt + min(75);
  const result = await sessions.settle(session.sessionId, CFG, { uid: "u1", effectiveElapsedMs: min(25) });
  chk("🔴 只算 25 分钟（不是 75）", result.countedMinutes, 25);
  chk("🔴 奖励 25 泡泡（不是 75）", result.reward, 25);
  chk("按自然完成处理", result.naturalCompletion, true);

  const stats = await store.stats("u1");
  chk("统计里的今日时长 = 25", stats.focusMinutesToday, 25);
  chk("统计里的今日次数 = 1", stats.focusCountToday, 1);
}

// ===== 4. 端到端（云 store）：与内存版口径一致 =====
console.log("\n--- 4. 端到端（云 store）：与内存版口径一致 ---");
{
  let clock = START;
  const state = { focus_records: [] };
  const stub = {
    from(table) {
      let op = null, payload = null, limitN = null;
      const filters = [];
      const hit = row => filters.every(([col, value]) => String(row[col]) === String(value));
      const builder = {
        select() { op = "select"; return builder; },
        insert(list) { op = "insert"; payload = list; return builder; },
        update(patch) { op = "update"; payload = patch; return builder; },
        eq(col, value) { filters.push([col, value]); return builder; },
        limit(n) { limitN = n; return builder; },
        throwOnError() {
          const rows = state[table] || (state[table] = []);
          if (op === "insert") { rows.push(...payload.map(r => ({ ...r }))); return { data: null }; }
          if (op === "update") { for (const r of rows) if (hit(r)) Object.assign(r, payload); return { data: null }; }
          const found = rows.filter(hit).map(r => ({ ...r }));
          return { data: limitN === null ? found : found.slice(0, limitN) };
        }
      };
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stub, { now: () => clock });
  const sessions = createFocusSessionStore({
    now: () => clock,
    persistence: {
      findSession: id => store.findFocusSession(id),
      consumeSession: id => store.claimFocusSession(id),
      settleSession: (id, patch) => store.settleFocusRecord(id, patch)
    }
  });

  const session = sessions.start({ plannedMinutes: 25, isMember: false, uid: "u1" });
  await store.addFocusRecord({
    id: session.sessionId, user_id: "u1", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: session.startedAt, settled_at: 0
  });

  clock = session.startedAt + min(75);
  const result = await sessions.settle(session.sessionId, CFG, { uid: "u1", effectiveElapsedMs: min(25) });
  chk("云版也只算 25 分钟（与内存版一致）", result.countedMinutes, 25);
  chk("云版奖励 25 泡泡", result.reward, 25);
  chk("云版写回 counted_minutes = 25", Number(state.focus_records[0].counted_minutes), 25);
  chk("云版写回 settled_at 是真实结算时间", Number(state.focus_records[0].settled_at), clock);

  const stats = await store.stats("u1");
  chk("云版统计今日时长 = 25", stats.focusMinutesToday, 25);
}

// ===== 5. 防重放没被修坏 =====
console.log("\n--- 5. 防重放没被修坏 ---");
{
  let clock = START;
  const store = createMemoryPlayerStore({ now: () => clock });
  const sessions = createFocusSessionStore({
    now: () => clock,
    persistence: {
      findSession: id => store.findFocusSession(id),
      consumeSession: id => store.claimFocusSession(id),
      settleSession: (id, patch) => store.settleFocusRecord(id, patch)
    }
  });
  const session = sessions.start({ plannedMinutes: 25, isMember: false, uid: "u1" });
  await store.addFocusRecord({
    id: session.sessionId, user_id: "u1", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: false,
    started_at: session.startedAt, settled_at: 0
  });
  clock = session.startedAt + min(25);
  chk("第一次结算成功", (await sessions.settle(session.sessionId, CFG, { uid: "u1", effectiveElapsedMs: min(25) })).countedMinutes, 25);
  chk("🔴 第二次结算返回 null（奖励不能重复领）",
    await sessions.settle(session.sessionId, CFG, { uid: "u1", effectiveElapsedMs: min(25) }), null);
  const foreign = await sessions.settle(session.sessionId, CFG, { uid: "u2", effectiveElapsedMs: min(25) });
  chk("别人的令牌仍然结算不了（归属校验没被绕开）", foreign && foreign.code, "SESSION_OWNER_MISMATCH");
}

console.log(`\n===== 专注恢复测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
