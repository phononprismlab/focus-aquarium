// 奖励计算与请求校验的单元测试。
// 运行：node test/reward.test.js
import { computeFocusReward, resolveMaxMinutes, validateStartRequest, HARD_MAX_MINUTES } from "../reward.js";

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

// 与 game-data.js / repository.js seed 保持一致的三档梯度
const TIERS = [
  { endMinute: 25, normalBubblePerMinute: 1, memberBubblePerMinute: 2 },
  { endMinute: 60, normalBubblePerMinute: 2, memberBubblePerMinute: 3 },
  { endMinute: 120, normalBubblePerMinute: 3, memberBubblePerMinute: 5 }
];

// ---- 分段累加 ----
chk("普通 0min", computeFocusReward(0, false, TIERS), 0);
chk("普通 25min", computeFocusReward(25, false, TIERS), 25 * 1);
chk("会员 25min", computeFocusReward(25, true, TIERS), 25 * 2);
chk("普通 60min", computeFocusReward(60, false, TIERS), 25 * 1 + 35 * 2);
chk("会员 60min", computeFocusReward(60, true, TIERS), 25 * 2 + 35 * 3);
chk("普通 120min", computeFocusReward(120, false, TIERS), 25 * 1 + 35 * 2 + 60 * 3);
chk("会员 120min", computeFocusReward(120, true, TIERS), 25 * 2 + 35 * 3 + 60 * 5);
// 超过最高档按最高档继续累加
chk("普通 180min（超出最高档）", computeFocusReward(180, false, TIERS), 25 * 1 + 35 * 2 + 60 * 3);

// ---- 脏数据归一 ----
chk("负数归一为 0", computeFocusReward(-10, false, TIERS), 0);
chk("小数向下取整", computeFocusReward(25.9, false, TIERS), 25);
chk("非法梯度被过滤", computeFocusReward(30, false, [{ endMinute: "x" }, { endMinute: -5 }, ...TIERS]), 25 * 1 + 5 * 2);
chk("乱序梯度自动排序", computeFocusReward(30, false, [...TIERS].reverse()), 25 * 1 + 5 * 2);
chk("重复梯度只算一次", computeFocusReward(30, false, [...TIERS, { endMinute: 25, normalBubblePerMinute: 99 }]), 25 * 1 + 5 * 2);
chk("空梯度返回 0", computeFocusReward(30, false, []), 0);
chk("非数组梯度返回 0", computeFocusReward(30, false, null), 0);

// ---- 时长上限 ----
chk("硬上限封顶 600", resolveMaxMinutes({ maxFocusDuration: 9999 }), HARD_MAX_MINUTES);
chk("取配置上限", resolveMaxMinutes({ maxFocusDuration: 45 }), 45);
chk("配置非法回落到硬上限", resolveMaxMinutes({ maxFocusDuration: -1 }), HARD_MAX_MINUTES);
chk("配置缺失回落到硬上限", resolveMaxMinutes({}), HARD_MAX_MINUTES);

// ---- 开始请求校验 ----
const CFG = { minFocusDuration: 25, maxFocusDuration: 120 };
chk("非对象请求体", validateStartRequest(null, CFG), "请求体必须是对象");
chk("plannedMinutes 非正数", validateStartRequest({ plannedMinutes: 0 }, CFG), "plannedMinutes 必须是正数");
chk("plannedMinutes 小于下限", validateStartRequest({ plannedMinutes: 3 }, CFG), "plannedMinutes 不能小于 25");
chk("plannedMinutes 超过上限", validateStartRequest({ plannedMinutes: 999 }, CFG), "plannedMinutes 不能大于 120");
chk("plannedMinutes 合法", validateStartRequest({ plannedMinutes: 25 }, CFG), null);
chk("plannedMinutes 边界合法（上限）", validateStartRequest({ plannedMinutes: 120 }, CFG), null);

console.log("----");
console.log(`reward.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
