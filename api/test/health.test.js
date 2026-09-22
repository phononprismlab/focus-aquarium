// 健康检查的测试。核心是"探针不能被数据层拖住"这一条：
// 之前 /api/health 会 await 仓库初始化，而仓库要连云开发 RDB 并串行补齐种子数据，
// 这段时间里云托管的探针一直探不通，最终把整个版本判成"部署版本失败"。
// 现象很迷惑人 —— 启动日志里服务明明已经 listening。
// 运行：node test/health.test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const PORT = "4291";

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
function chkTrue(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS | ${name}${detail ? ` (${detail})` : ""}`);
    pass++;
  } else {
    console.log(`FAIL | ${name}${detail ? ` (${detail})` : ""}`);
    fail++;
  }
}

const base = `http://127.0.0.1:${PORT}`;
const started = Date.now();

// CLOUDBASE_ENV_ID 故意给一个不存在的环境：仓库初始化必然失败/耗时，
// 正是要验证这种情况下探针仍然立刻拿到 200。
const server = spawn(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: {
    ...process.env,
    PORT,
    NODE_ENV: "production",
    ADMIN_API_KEY: "health-test-key-0123456789",
    CLOUDBASE_ENV_ID: "test-nonexistent-env-for-health-test",
    CLOUDBASE_APIKEY: "bogus-key",
    CORS_ORIGINS: "https://example.com/"
  }
});
let logs = "";
server.stdout.on("data", d => { logs += d.toString(); });
server.stderr.on("data", d => { logs += d.toString(); });

const health = async () => {
  const t = Date.now();
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  return { status: res.status, body, ms: Date.now() - t };
};

try {
  // 端口一开就立刻打，尽量落在"仓库还没就绪"的窗口里。
  let first = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { first = await health(); break; } catch { await new Promise(r => setTimeout(r, 30)); }
  }

  chkTrue("服务能在 10s 内起来", Boolean(first));
  if (first) {
    const openedAt = Date.now() - started;
    console.log(`     端口可用耗时约 ${openedAt}ms，首次健康检查 ${first.ms}ms：${JSON.stringify(first.body)}`);

    chk("健康检查状态码", first.status, 200);
    chk("健康检查 ok", first.body.ok, true);
    chk("报告存储驱动", first.body.storage, "cloudbase");
    chk("报告 CORS 来源来自环境变量", first.body.cors, "configured");
    chk("报告管理鉴权已启用", first.body.adminAuth, "enabled");
    chkTrue("数据层状态是已知值", ["pending", "ok", "failed"].includes(first.body.repository), `repository=${first.body.repository}`);

    // 关键断言：不管数据层什么状态，探针都必须秒回。
    // 旧实现会 await 仓库，真实环境下这段时间是十几秒级的网络往返。
    chkTrue("首次健康检查在 1s 内返回", first.ms < 1000, `${first.ms}ms`);

    const samples = [];
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 200));
      samples.push(await health());
    }
    chkTrue("后续健康检查全部 200", samples.every(s => s.status === 200));
    chkTrue("后续健康检查延迟均低于 300ms", samples.every(s => s.ms < 300), samples.map(s => `${s.ms}ms`).join(", "));
    chkTrue("健康检查不会因为数据层失败而报 5xx", samples.every(s => s.status < 500), samples.map(s => s.status).join(", "));

    // 数据层状态最终应该落到 failed（环境是编造的），但探针结论不受影响。
    const settled = await health();
    console.log(`     数据层最终状态：${settled.body.repository}`);
    chkTrue("数据层失败后探针仍为 200", settled.status === 200, `status=${settled.status}`);
    chkTrue("启动日志里有 listening（对照用）", logs.includes("listening on port"), "");

    // 启动自检是区分「应用没监听」和「平台探不到」的唯一依据，不能悄悄失效。
    const logDeadline = Date.now() + 3000;
    while (Date.now() < logDeadline && !/启动自检：http[^\n]*-> 200/.test(logs)) {
      await new Promise(r => setTimeout(r, 100));
    }
    chkTrue("启动日志含绑定详情", logs.includes("启动自检：已绑定"), "");
    chkTrue("启动自检至少一次拿到 200", /启动自检：http[^\n]*-> 200/.test(logs), "");
    const selfCheckLines = logs.split("\n").filter(line => line.includes("启动自检")).map(line => line.trim());
    selfCheckLines.forEach(line => console.log(`     ${line}`));
  }
} finally {
  server.kill();
}

console.log("----");
console.log(`health.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
