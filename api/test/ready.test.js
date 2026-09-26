// readiness 探针的测试。与 health.test.js 是一对：
//   /api/health = 进程活着吗（永远 200，绝不碰数据层）
//   /api/ready  = 现在能接客吗（真的打一次数据库，不通就 503）
// 这里要锁三件事：
//   1. 数据库连不上时 /api/ready 必须是 503，且**不能挂死**（探针自带超时）。
//   2. 同一个进程里 /api/health 仍然 200 —— 两条探针的职责不能混。
//   3. 数据层正常（内存实现）时 /api/ready 是 200 且 ready=true。
// 运行：node test/ready.test.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

let pass = 0;
let fail = 0;
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

// 起一个服务，等到 /api/health 通了再返回（health 永远 200，是最稳的「进程已监听」信号）。
async function startServer(port, env) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "",
      NODE_ENV: "production",
      ADMIN_API_KEY: "ready-test-key-0123456789",
      CORS_ORIGINS: "https://example.com/",
      ...env
    }
  });
  let logs = "";
  server.stdout.on("data", d => { logs += d.toString(); });
  server.stderr.on("data", d => { logs += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { up = true; break; }
    } catch { /* 还没监听 */ }
    await new Promise(r => setTimeout(r, 50));
  }
  return { server, base, logs, up };
}

try {
  // ===== 1. 数据库连不上（编造的云环境）=====
  console.log("--- 数据库不可用时 ---");
  {
    const bogus = await startServer(4292, {
      CLOUDBASE_ENV_ID: "test-nonexistent-env-for-ready-test",
      CLOUDBASE_APIKEY: "bogus-key"
    });
    chkTrue("服务能起来", bogus.up);
    const t = Date.now();
    const res = await fetch(`${bogus.base}/api/ready`);
    const body = await res.json();
    const ms = Date.now() - t;
    console.log(`     /api/ready ${ms}ms ${res.status} ${JSON.stringify(body)}`);

    chk("数据库不通时状态码", res.status, 503);
    chk("ready 为 false", body.ready, false);
    chkTrue("ready 不挂死（探针自带超时）", ms < 10000, `${ms}ms`);
    chkTrue("数据层状态是已知值", ["pending", "ok", "failed"].includes(body.repository), `repository=${body.repository}`);
    chkTrue("给出了不通的原因", typeof (body.database && body.database.error) === "string", String(body.database && body.database.error));

    // 关键区分：同一时刻 health 依然是 200 —— 它只回答「进程活着吗」。
    const healthRes = await fetch(`${bogus.base}/api/health`);
    const healthBody = await healthRes.json();
    chk("同一进程 /api/health 仍是 200", healthRes.status, 200);
    chk("同一进程 /api/health 仍报 ok", healthBody.ok, true);
    bogus.server.kill();
  }

  // ===== 2. 数据层正常（内存实现）=====
  console.log("\n--- 数据层可用时 ---");
  {
    // 内存数据层只在非 production 下可用（生产缺 CLOUDBASE_ENV_ID 会直接拒绝启动，
    // 见 repository.js 的 createRepository）—— 所以这里显式用 test 环境跑「一切正常」这一路。
    const ok = await startServer(4293, { NODE_ENV: "test", CLOUDBASE_ENV_ID: "", CLOUDBASE_APIKEY: "" });
    chkTrue("服务能起来（内存数据层）", ok.up);
    const res = await fetch(`${ok.base}/api/ready`);
    const body = await res.json();
    console.log(`     /api/ready ${res.status} ${JSON.stringify(body)}`);

    chk("数据层可用时状态码", res.status, 200);
    chk("ready 为 true", body.ready, true);
    chk("仓库状态 ok", body.repository, "ok");
    chk("玩家数据层状态 ok", body.playerStore, "ok");
    chk("数据库连通", body.database.ok, true);
    chk("报告数据层驱动", body.database.driver, "memory");
    ok.server.kill();
  }
} finally {
  // 兜底：任何路径下都别把测试进程挂在后台服务上。
}

console.log("----");
console.log(`ready.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
