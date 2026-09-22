// HTTP 冒烟测试：验证服务端接口的鉴权、参数校验、专注结算与音频分类全链路。
// 用法（PowerShell）：
//   1. 另开窗口启动服务：$env:PORT="4173"; $env:ADMIN_API_KEY="test-key-123"; node server.js
//   2. 运行：$env:BASE_URL="http://127.0.0.1:4173"; $env:ADMIN_API_KEY="test-key-123"; node test/smoke.mjs
// Git Bash / WSL 改用：PORT=4173 ADMIN_API_KEY=test-key-123 node server.js
// 注意：若本机配置了 http_proxy，Node 的 fetch 默认不走代理，可直接访问 localhost。
//       但用 curl 手测时要加 --noproxy '*'，否则会被代理拦成 502。
import process from "node:process";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

let pass = 0;
let fail = 0;
function chk(name, actual, expected) {
  if (String(actual) === String(expected)) {
    console.log(`PASS | ${name} (${actual})`);
    pass++;
  } else {
    console.log(`FAIL | ${name} 期望=${expected} 实际=${actual}`);
    fail++;
  }
}

async function status(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  return res.status;
}

async function json(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  let body = null;
  try { body = await res.json(); } catch { /* 忽略非 JSON 响应 */ }
  return { status: res.status, body };
}

const jsonHeaders = { "Content-Type": "application/json" };

console.log(`冒烟测试目标：${BASE_URL}`);
console.log(`管理密钥：${ADMIN_API_KEY ? "已提供" : "未提供（admin 鉴权用例会被跳过）"}`);

// ---- 健康检查 ----
const health = await json("/api/health");
chk("GET /api/health 状态", health.status, 200);
chk("health.ok", health.body?.ok, true);
console.log(`     health 详情：${JSON.stringify(health.body)}`);

// ---- 管理接口鉴权 ----
if (ADMIN_API_KEY) {
  chk("admin 无密钥 -> 401", await status("/api/admin/audio"), 401);
  chk("admin 错误密钥 -> 401", await status("/api/admin/audio", { headers: { "x-admin-key": "wrong-key" } }), 401);
  chk("admin 正确密钥 -> 200", await status("/api/admin/audio", { headers: { "x-admin-key": ADMIN_API_KEY } }), 200);
}

// ---- 专注开始：参数校验 ----
const okStart = await json("/api/game/focus/start", {
  method: "POST", headers: jsonHeaders, body: JSON.stringify({ plannedMinutes: 25, isMember: false })
});
chk("focus/start 合法 -> 201", okStart.status, 201);
const sessionId = okStart.body?.data?.sessionId || "";
chk("focus/start 返回 sessionId", sessionId.length > 0, true);

chk("focus/start 0 分钟 -> 400", await status("/api/game/focus/start", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ plannedMinutes: 0 }) }), 400);
chk("focus/start 缺参 -> 400", await status("/api/game/focus/start", { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) }), 400);
chk("focus/start 超上限 -> 400", await status("/api/game/focus/start", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ plannedMinutes: 99999 }) }), 400);

// ---- 专注结算 ----
const complete = await json("/api/game/focus/complete", {
  method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId })
});
chk("focus/complete 合法 -> 200", complete.status, 200);
chk("focus/complete 返回 reward 字段", typeof complete.body?.data?.reward, "number");
console.log(`     结算详情：${JSON.stringify(complete.body?.data)}`);

// 防重放：同一 sessionId 二次结算必须失败
chk("focus/complete 重放 -> 404", await status("/api/game/focus/complete", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId }) }), 404);
chk("focus/complete 未知会话 -> 404", await status("/api/game/focus/complete", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId: "nope" }) }), 404);
chk("focus/complete 缺参 -> 400", await status("/api/game/focus/complete", { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) }), 400);

// ---- 公开配置读取：/api/game/{type}，返回已发布数据 ----
for (const type of ["decorations", "fish", "focus", "audio"]) {
  const result = await json(`/api/game/${type}`);
  chk(`GET /api/game/${type} -> 200`, result.status, 200);
  chk(`/api/game/${type} 返回数组`, Array.isArray(result.body?.data), true);
}
const focusConfig = await json("/api/game/focus");
const focusData = focusConfig.body?.data?.[0]?.data;
chk("focus 配置含 rewardTiers", Array.isArray(focusData?.rewardTiers), true);
console.log(`     focus 配置：min=${focusData?.minFocusDuration} max=${focusData?.maxFocusDuration} tiers=${focusData?.rewardTiers?.length}`);

// ---- 音频分类体系：增删改要能通过接口往返 ----
// 注意：这几步会写库，只在测试实例上跑。
if (ADMIN_API_KEY) {
  const adminHeaders = { ...jsonHeaders, "x-admin-key": ADMIN_API_KEY };
  const put = (payload) => json("/api/admin/audio/audio", { method: "PUT", headers: adminHeaders, body: JSON.stringify(payload) });

  // 自定义分类（含后台新增的分类）应被接受
  const custom = {
    categories: {
      bgm: { label: "海浪", enabled: true, volume: 40 },
      voice: { label: "人声", enabled: true, volume: 70 }
    },
    sounds: [{ id: "v1", name: "人声示例", category: "voice", enabled: true, volume: 100 }]
  };
  const saved = await put(custom);
  chk("PUT 自定义分类 -> 200", saved.status, 200);
  chk("保存后 categories 含 voice", Object.keys(saved.body?.data?.data?.categories || {}).includes("voice"), true);

  // 校验：引用未定义分类 / 非法 key / 空分类 / 缺 label
  chk("PUT 引用未定义分类 -> 400", (await put({
    categories: { bgm: { label: "a", volume: 50 } },
    sounds: [{ id: "s1", name: "n", category: "ghost", volume: 100 }]
  })).status, 400);
  chk("PUT 非法分类 key -> 400", (await put({
    categories: { "bad key": { label: "x", volume: 50 } },
    sounds: []
  })).status, 400);
  chk("PUT 空分类 -> 400", (await put({ categories: {}, sounds: [] })).status, 400);
  chk("PUT 分类缺 label -> 400", (await put({
    categories: { bgm: { volume: 50 } },
    sounds: []
  })).status, 400);

  // 发布后公开接口应能看到新分类
  const published = await json("/api/admin/audio/audio/publish", { method: "POST", headers: adminHeaders });
  chk("发布音频配置 -> 200", published.status, 200);
  const publicAudio = await json("/api/game/audio");
  const publicCategories = Object.keys(publicAudio.body?.data?.[0]?.data?.categories || {});
  chk("公开接口含自定义分类 voice", publicCategories.includes("voice"), true);
  console.log(`     公开分类：${publicCategories.join(", ")}`);

  // 还原为内置三类，避免影响后续测试
  const restored = await put({
    categories: {
      bgm: { label: "背景白噪音", enabled: true, volume: 38 },
      prompt: { label: "提示音", enabled: true, volume: 100 },
      sfx: { label: "交互音效", enabled: true, volume: 100 }
    },
    sounds: [
      { id: "water-ambient", name: "海水白噪音", category: "bgm", enabled: true, volume: 100, resourcePath: "assets/sounds/water-ambient.mp3", loop: true },
      { id: "focus-start", name: "开始专注", category: "prompt", enabled: true, volume: 100, resourcePath: "" },
      { id: "focus-complete", name: "专注完成", category: "prompt", enabled: true, volume: 100, resourcePath: "" },
      { id: "feed", name: "投喂饲料", category: "sfx", enabled: true, volume: 100, resourcePath: "" },
      { id: "fish-startle", name: "鱼儿受惊", category: "sfx", enabled: true, volume: 100, resourcePath: "" }
    ]
  });
  chk("还原内置分类 -> 200", restored.status, 200);
  chk("还原后分类为内置三类", Object.keys(restored.body?.data?.data?.categories || {}).sort(), ["bgm", "prompt", "sfx"]);
  await json("/api/admin/audio/audio/publish", { method: "POST", headers: adminHeaders });
}

console.log("----");
console.log(`smoke: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
