// 专注会话存储的单元测试。注入 now() 模拟时间流逝，无需真实等待。
// 运行：node test/focus-session.test.js
import { createFocusSessionStore, FOCUS_SESSION_TTL_MS, COMPLETION_TOLERANCE_MS } from "../focus-session.js";

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
function chkTrue(name, condition) {
  chk(name, condition === true, true);
}

const TIERS = [
  { endMinute: 25, normalBubblePerMinute: 1, memberBubblePerMinute: 2 },
  { endMinute: 60, normalBubblePerMinute: 2, memberBubblePerMinute: 3 },
  { endMinute: 120, normalBubblePerMinute: 3, memberBubblePerMinute: 5 }
];
const CFG = { minFocusDuration: 25, maxFocusDuration: 120, rewardTiers: TIERS };

let clock = 1_000_000;
const store = createFocusSessionStore({ now: () => clock });
const advance = ms => { clock += ms; };

// ---- 自然完成 ----
const s1 = store.start({ plannedMinutes: 25, isMember: false });
chk("start 返回 sessionId", typeof s1.sessionId === "string" && s1.sessionId.length > 0, true);
chk("start 回显 plannedMinutes", s1.plannedMinutes, 25);
advance(25 * 60000);
const r1 = await store.settle(s1.sessionId, CFG);
chk("自然完成 countedMinutes", r1.countedMinutes, 25);
chk("自然完成 reward", r1.reward, 25);
chk("自然完成 naturalCompletion", r1.naturalCompletion, true);

// ---- 防重放：同一会话只能结算一次 ----
chk("重复结算返回 null", await store.settle(s1.sessionId, CFG), null);

// ---- 提前结束：按实际耗时计算 ----
const s2 = store.start({ plannedMinutes: 25, isMember: true });
advance(10 * 60000);
const r2 = await store.settle(s2.sessionId, CFG);
chk("提前结束 countedMinutes", r2.countedMinutes, 10);
chk("提前结束 reward", r2.reward, 10 * 2);
chk("提前结束 naturalCompletion", r2.naturalCompletion, false);

// ---- 计时器到点容差：25 分钟差 2 秒也算自然完成 ----
const s3 = store.start({ plannedMinutes: 25, isMember: false });
advance(25 * 60000 - 2000);
const r3 = await store.settle(s3.sessionId, CFG);
chk("容差内算自然完成", r3.naturalCompletion, true);
chk("容差内 countedMinutes", r3.countedMinutes, 25);

// ---- 超时封顶：走 5 小时（>120min 上限，<6h TTL）----
const s4 = store.start({ plannedMinutes: 120, isMember: true });
advance(300 * 60000);
const r4 = await store.settle(s4.sessionId, CFG);
chk("超时 countedMinutes 封顶", r4.countedMinutes, 120);
chk("超时 capped 标记", r4.capped, true);

// ---- 过期会话：超过 TTL 不可结算 ----
const s5 = store.start({ plannedMinutes: 25, isMember: false });
advance(FOCUS_SESSION_TTL_MS + 60000);
chk("过期会话返回 null", await store.settle(s5.sessionId, CFG), null);

// ---- 未知会话 ----
chk("未知 sessionId 返回 null", await store.settle("does-not-exist", CFG), null);

// ---- 会员标记由服务端持有，不受客户端声明影响 ----
const s6 = store.start({ plannedMinutes: 25, isMember: false });
advance(25 * 60000);
const r6 = await store.settle(s6.sessionId, CFG);
chk("非会员按普通档计", r6.reward, 25 * 1);

// ---- prune 在 start 时回收过期会话 ----
const store2 = createFocusSessionStore({ now: () => clock });
store2.start({ plannedMinutes: 25, isMember: false });
store2.start({ plannedMinutes: 25, isMember: false });
chk("start 前 size=2", store2.size(), 2);
advance(FOCUS_SESSION_TTL_MS + 60000);
store2.start({ plannedMinutes: 25, isMember: false });
chk("start 触发剪枝后 size=1", store2.size(), 1);

chk("COMPLETION_TOLERANCE_MS 为 5 秒", COMPLETION_TOLERANCE_MS, 5000);

// ===== 持久层（云托管扩缩容后，start 与 complete 可能不在同一个实例上）=====
// 用一个内存版「会话表」模拟 focus_records，注入到两个**互相独立**的 store 里 ——
// 这正好对应「实例 A 处理 start、实例 B 处理 complete」的真实场景。
console.log("\n--- 持久层：跨实例 / 跨重启结算 ---");
function fakePersistence() {
  const rows = new Map();
  return {
    rows,
    findSession: async id => rows.get(id) || null,
    consumeSession: async (id, _claimedAt) => {
      const row = rows.get(id);
      if (!row || Number(row.settled_at) > 0) return false;
      row.settled_at = -1; // 哨兵，与内存实现同语义
      return true;
    },
    settleSession: async (id, patch) => {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, {
        counted_minutes: patch.countedMinutes,
        reward: patch.reward,
        natural: patch.natural,
        settled_at: patch.settledAt
      });
      return { ...row, alreadySettled: false };
    }
  };
}

{
  const clock2 = { t: 2_000_000 };
  const persistent = fakePersistence();
  const makeStore = () => createFocusSessionStore({ now: () => clock2.t, persistence: persistent });

  // 实例 A 开专注
  const instA = makeStore();
  const s = instA.start({ plannedMinutes: 25, isMember: false, uid: "u-alice" });
  // start 之后把会话行写进"表"（真实流程里是 server.js 的 addFocusRecord）
  persistent.rows.set(s.sessionId, {
    id: s.sessionId, user_id: "u-alice", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: 0, started_at: s.startedAt, settled_at: 0
  });

  // 实例 B：完全不知道这个会话（自己的 Map 是空的），但库里查得到 → 必须能结算
  clock2.t += 25 * 60000;
  const instB = makeStore();
  chk("实例 B 自己不知道这个会话", instB.size(), 0);
  const cross = await instB.settle(s.sessionId, CFG, { uid: "u-alice" });
  chk("跨实例结算成功（不再 404）", cross.countedMinutes, 25);
  chk("跨实例结算奖励正确", cross.reward, 25);

  // 结算结果要真的写回"表"里，否则统计与防重放都失效
  chk("结算结果写回持久层", persistent.rows.get(s.sessionId).counted_minutes, 25);
  chkTrue("持久层标记已结算", Number(persistent.rows.get(s.sessionId).settled_at) > 0);

  // 防重放：换个实例再结算一次必须失败
  const instC = makeStore();
  chk("另一个实例重复结算返回 null", await instC.settle(s.sessionId, CFG, { uid: "u-alice" }), null);

  // 归属校验：会话属于 alice，bob 不能替他结算
  const s2 = makeStore().start({ plannedMinutes: 25, isMember: false, uid: "u-alice" });
  persistent.rows.set(s2.sessionId, {
    id: s2.sessionId, user_id: "u-alice", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: 0, started_at: s2.startedAt, settled_at: 0
  });
  clock2.t += 25 * 60000;
  const stolen = await makeStore().settle(s2.sessionId, CFG, { uid: "u-bob" });
  chk("别人替他结算被拒（返回归属错误）", stolen.code, "SESSION_OWNER_MISMATCH");
  chkTrue("被拒后会话仍未被消费", Number(persistent.rows.get(s2.sessionId).settled_at) === 0);
  const legit = await makeStore().settle(s2.sessionId, CFG, { uid: "u-alice" });
  chk("本人随后仍能正常结算", legit.countedMinutes, 25);

  // 未登录会话（uid 为空）：不校验归属，任何人拿到 sessionId 都能结算
  const s3 = makeStore().start({ plannedMinutes: 25, isMember: false, uid: null });
  persistent.rows.set(s3.sessionId, {
    id: s3.sessionId, user_id: "", planned_minutes: 25,
    counted_minutes: 0, reward: 0, natural: 0, started_at: s3.startedAt, settled_at: 0
  });
  clock2.t += 25 * 60000;
  chk("未登录会话不校验归属", (await makeStore().settle(s3.sessionId, CFG, { uid: "u-bob" })).countedMinutes, 25);

  // 持久层抛错 → 不能把专注搞挂，退回内存路径照常发奖
  const brokenStore = createFocusSessionStore({
    now: () => clock2.t,
    persistence: {
      findSession: async () => { throw new Error("库挂了"); },
      consumeSession: async () => { throw new Error("库挂了"); },
      settleSession: async () => { throw new Error("库挂了"); }
    },
    onPersistError: () => {}
  });
  const s4 = brokenStore.start({ plannedMinutes: 25, isMember: false, uid: "u-alice" });
  clock2.t += 25 * 60000;
  const fallback = await brokenStore.settle(s4.sessionId, CFG, { uid: "u-alice" });
  chk("库挂时退回内存路径照常结算", fallback.countedMinutes, 25);
  chk("库挂时奖励照发", fallback.reward, 25);

  // 库里没这行、内存里也没有 → null（不是"凭空发奖"）
  chk("两边都查不到返回 null", await makeStore().settle("never-existed", CFG, { uid: "u-alice" }), null);
}

console.log("----");
console.log(`focus-session.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
