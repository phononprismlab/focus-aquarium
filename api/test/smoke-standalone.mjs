// 一条命令跑完冒烟测试：自己起服务、等就绪、跑 smoke.mjs、再关掉服务。
// 省去"开两个窗口、手动设环境变量、别忘了关服务"的麻烦。
//
// 用法（在 api 目录下）：
//   node test/smoke-standalone.mjs
//   node test/smoke-standalone.mjs --port 4180        # 换端口
//   node test/smoke-standalone.mjs --keep             # 跑完保留服务，方便手动继续调接口
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = String(argValue("--port", process.env.SMOKE_PORT || "4173"));
const ADMIN_KEY = process.env.SMOKE_ADMIN_KEY || "test-key-123";
const KEEP_RUNNING = process.argv.includes("--keep");
const BASE_URL = `http://127.0.0.1:${PORT}`;

console.log(`[1/3] 启动服务（端口 ${PORT}）…`);
// 服务日志直接打到当前终端，出问题时你能立刻看到原因。
// 不设 NODE_ENV：走开发模式的内存仓库，测试不依赖云环境。
const server = spawn(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: { ...process.env, PORT, EXTRA_PORTS: "", ADMIN_API_KEY: ADMIN_KEY, CORS_ORIGINS: "*" },
  stdio: ["ignore", "inherit", "inherit"]
});

let serverExited = false;
server.on("exit", () => { serverExited = true; });

function shutdown() {
  if (!serverExited) server.kill();
}

// 兜底：Ctrl+C 或脚本异常退出时，别把服务进程留在后台占着端口。
process.on("SIGINT", () => { shutdown(); process.exit(130); });
process.on("exit", () => { if (!KEEP_RUNNING) shutdown(); });

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited) return false;
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来，继续等 */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

const ready = await waitForHealth();
if (!ready) {
  console.error(`\n服务没能启动。若上面出现 EADDRINUSE，说明端口 ${PORT} 被占用，换一个重试：`);
  console.error(`  node test/smoke-standalone.mjs --port 4180`);
  shutdown();
  process.exit(1);
}
console.log(`      服务已就绪：${BASE_URL}\n`);

console.log("[2/3] 运行冒烟测试…\n");
const smoke = spawn(process.execPath, [path.join(here, "smoke.mjs")], {
  cwd: apiDir,
  env: { ...process.env, BASE_URL, ADMIN_API_KEY: ADMIN_KEY },
  stdio: "inherit"
});
const exitCode = await new Promise(resolve => smoke.on("exit", resolve));

console.log("");
if (KEEP_RUNNING) {
  console.log(`[3/3] --keep 已指定，服务继续运行在 ${BASE_URL}（按 Ctrl+C 结束）`);
} else {
  console.log("[3/3] 关闭服务…");
  shutdown();
}

process.exit(exitCode ?? 1);
