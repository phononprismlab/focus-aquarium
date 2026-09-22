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
const r1 = store.settle(s1.sessionId, CFG);
chk("自然完成 countedMinutes", r1.countedMinutes, 25);
chk("自然完成 reward", r1.reward, 25);
chk("自然完成 naturalCompletion", r1.naturalCompletion, true);

// ---- 防重放：同一会话只能结算一次 ----
chk("重复结算返回 null", store.settle(s1.sessionId, CFG), null);

// ---- 提前结束：按实际耗时计算 ----
const s2 = store.start({ plannedMinutes: 25, isMember: true });
advance(10 * 60000);
const r2 = store.settle(s2.sessionId, CFG);
chk("提前结束 countedMinutes", r2.countedMinutes, 10);
chk("提前结束 reward", r2.reward, 10 * 2);
chk("提前结束 naturalCompletion", r2.naturalCompletion, false);

// ---- 计时器到点容差：25 分钟差 2 秒也算自然完成 ----
const s3 = store.start({ plannedMinutes: 25, isMember: false });
advance(25 * 60000 - 2000);
const r3 = store.settle(s3.sessionId, CFG);
chk("容差内算自然完成", r3.naturalCompletion, true);
chk("容差内 countedMinutes", r3.countedMinutes, 25);

// ---- 超时封顶：走 5 小时（>120min 上限，<6h TTL）----
const s4 = store.start({ plannedMinutes: 120, isMember: true });
advance(300 * 60000);
const r4 = store.settle(s4.sessionId, CFG);
chk("超时 countedMinutes 封顶", r4.countedMinutes, 120);
chk("超时 capped 标记", r4.capped, true);

// ---- 过期会话：超过 TTL 不可结算 ----
const s5 = store.start({ plannedMinutes: 25, isMember: false });
advance(FOCUS_SESSION_TTL_MS + 60000);
chk("过期会话返回 null", store.settle(s5.sessionId, CFG), null);

// ---- 未知会话 ----
chk("未知 sessionId 返回 null", store.settle("does-not-exist", CFG), null);

// ---- 会员标记由服务端持有，不受客户端声明影响 ----
const s6 = store.start({ plannedMinutes: 25, isMember: false });
advance(25 * 60000);
const r6 = store.settle(s6.sessionId, CFG);
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

console.log("----");
console.log(`focus-session.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
