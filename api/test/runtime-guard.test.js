// #13 生产环境强制校验 ADMIN_API_KEY 的测试。
// 分两层：
//   1) 纯函数单测（resolveAdminApiKey / checkProductionConfig / warnWeakAdminKey）
//   2) 真起进程的端到端验证：生产环境漏配密钥必须拒绝启动
// 运行：node test/runtime-guard.test.js
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdminApiKey, checkProductionConfig, warnWeakAdminKey, MIN_RECOMMENDED_ADMIN_KEY_LENGTH } from "../runtime-guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

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

// ---------- 1. 纯函数 ----------
console.log("--- 纯函数 ---");
chk("未配置密钥返回空串", resolveAdminApiKey({}), "");
chk("密钥去首尾空格", resolveAdminApiKey({ ADMIN_API_KEY: "  abc123  " }), "abc123");
chk("纯空格视为未配置", resolveAdminApiKey({ ADMIN_API_KEY: "   " }), "");
chk("非字符串值被转换", resolveAdminApiKey({ ADMIN_API_KEY: 12345 }), "12345");

chk("开发环境不拦截", checkProductionConfig({ nodeEnv: "development", adminApiKey: "" }), null);
chk("未设 NODE_ENV 不拦截", checkProductionConfig({ nodeEnv: undefined, adminApiKey: "" }), null);
chk("测试环境不拦截", checkProductionConfig({ nodeEnv: "test", adminApiKey: "" }), null);
chk("生产环境有密钥通过", checkProductionConfig({ nodeEnv: "production", adminApiKey: "s3cret-key-123456" }), null);
const prodError = checkProductionConfig({ nodeEnv: "production", adminApiKey: "" });
chk("生产环境无密钥被拦截", typeof prodError === "string" && prodError.includes("ADMIN_API_KEY"), true);

chk("弱密钥返回提示", typeof warnWeakAdminKey("short", () => {}) === "string", true);
chk("强密钥不提示", warnWeakAdminKey("a".repeat(MIN_RECOMMENDED_ADMIN_KEY_LENGTH), () => {}), null);
chk("无密钥不提示（交给 checkProductionConfig 处理）", warnWeakAdminKey("", () => {}), null);
chk("弱密钥不抛错只记录", warnWeakAdminKey("abc", () => {}).includes("3 位"), true);

// ---------- 2. 端到端：真起进程 ----------
console.log("--- 端到端启动校验 ---");
const baseEnv = { ...process.env, PORT: "4181", EXTRA_PORTS: "", CORS_ORIGINS: "*" };
delete baseEnv.ADMIN_API_KEY;
delete baseEnv.NODE_ENV;

// 2.1 生产环境 + 无密钥 → 必须退出且退出码非 0
const denied = spawnSync(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: { ...baseEnv, NODE_ENV: "production" },
  encoding: "utf8",
  timeout: 15000
});
chk("生产环境无密钥退出码非 0", denied.status !== 0, true);
chk("报错信息点明原因", String(denied.stderr || "").includes("ADMIN_API_KEY"), true);
console.log(`     进程输出：${String(denied.stderr || "").trim().split("\n")[0]}`);
chk("拒绝启动时不会监听端口", String(denied.stdout || "").includes("listening"), false);

// 2.2 生产环境 + 有密钥 → 能起来，且管理接口确实要鉴权
const KEY = "prod-test-key-0123456789";
const running = spawn(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: { ...baseEnv, NODE_ENV: "production", ADMIN_API_KEY: KEY }
});
let stdout = "";
running.stdout.on("data", chunk => { stdout += chunk.toString(); });
running.stderr.on("data", chunk => { stdout += chunk.toString(); });

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:4181/api/health");
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

try {
  const up = await waitForServer();
  chk("生产环境有密钥可以启动", up, true);
  if (up) {
    chk("启动日志声明鉴权已启用", stdout.includes("已启用"), true);

    // 鉴权中间件在访问仓库之前执行，所以「401 与否」能干净地反映鉴权结果。
    // 注意：本沙箱没有 CLOUDBASE_ENV_ID，生产模式下仓库初始化会失败，
    // 因此通过鉴权之后的请求会拿到 500 —— 那是仓库的问题（#12），不是鉴权的问题。
    chk("生产环境 admin 无密钥 -> 401", (await fetch("http://127.0.0.1:4181/api/admin/audio")).status, 401);
    chk("生产环境 admin 错误密钥 -> 401", (await fetch("http://127.0.0.1:4181/api/admin/audio", { headers: { "x-admin-key": "wrong-key" } })).status, 401);

    const withKey = await fetch("http://127.0.0.1:4181/api/admin/audio", { headers: { "x-admin-key": KEY } });
    chk("生产环境 admin 正确密钥已通过鉴权（不再 401）", withKey.status !== 401, true);

    const publicRead = await fetch("http://127.0.0.1:4181/api/game/audio");
    chk("公开配置接口不因鉴权被拦（未 401）", publicRead.status !== 401, true);
  }
} finally {
  running.kill();
}

console.log("----");
console.log(`runtime-guard.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
