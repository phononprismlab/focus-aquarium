// 绑定失败的回归测试。
//
// 真机现象（连续三轮部署失败）：启动日志打印 "Fishtank API listening on port 80"，
// 平台探针却报 connection refused，应用侧没有任何错误日志。
//
// 根因：Express 5 的 app.listen 会把回调同时挂到 server 的 'error' 事件上
//   app.listen = function () { ...; server.once('error', done); return server.listen(...) }
// 绑定失败时这个回调会被当作错误回调调用，第一个参数是 error。
// 旧代码忽略参数 → 打印 listening（假成功），而 server.address() 返回 null，
// 于是自检只留下一句「监听地址异常（null）」，真正的错误码被彻底吞掉。
//
// 这个测试把端口先占住制造 EADDRINUSE，验证：
//   1) 失败必须可见（打印错误码，而不是静默）
//   2) 不能再打印误导性的 listening
//   3) 必须以非 0 退出，让编排层立刻看到失败，而不是让容器带病运行
// 运行：node test/bind-failure.test.js
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

// 端口不能写死。这条测试的思路是"先自己占住一个端口，再让 server.js 去撞它"，
// 一旦本机正好有别的进程在用同一个号（上一次没退干净的 server.js、并行跑的测试进程），
// blocker 自己就绑不上，测试会报一个和被测逻辑毫无关系的假失败。
// 改成向系统要一个空闲端口，测试结果只反映被测行为。
async function holdFreePort() {
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  return { server, port: server.address().port };
}

let pass = 0;
let fail = 0;
function chkTrue(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS | ${name}${detail ? ` (${detail})` : ""}`);
    pass++;
  } else {
    console.log(`FAIL | ${name}${detail ? ` (${detail})` : ""}`);
    fail++;
  }
}

const { server: blocker, port: PORT } = await holdFreePort();
console.log(`     已占住 ${PORT}，制造 EADDRINUSE`);

const child = spawn(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    EXTRA_PORTS: "",
    NODE_ENV: "production",
    ADMIN_API_KEY: "bind-failure-test-key-0123456789",
    CLOUDBASE_ENV_ID: "test-nonexistent-env-for-bind-test",
    CLOUDBASE_APIKEY: "bogus-key"
  }
});

let logs = "";
child.stdout.on("data", d => { logs += d.toString(); });
child.stderr.on("data", d => { logs += d.toString(); });

const exitCode = await new Promise(resolve => {
  const timer = setTimeout(() => resolve("timeout"), 10000);
  child.on("exit", code => { clearTimeout(timer); resolve(code); });
});

console.log("     ---- 子进程输出 ----");
(logs.trim() || "(无输出)").split("\n").forEach(line => console.log(`     ${line.trim()}`));
console.log("     ---- 断言 ----");

chkTrue("绑定失败时进程没有挂住", exitCode !== "timeout", `exitCode=${exitCode}`);
chkTrue("绑定失败时以非 0 退出（编排层能立刻发现）", exitCode !== 0 && exitCode !== "timeout", `exitCode=${exitCode}`);
chkTrue("日志明确报告该端口无法监听", logs.includes(`监听 0.0.0.0:${PORT} 失败`), "");
chkTrue("日志给出真实错误码 EADDRINUSE", logs.includes("EADDRINUSE"), "");
chkTrue("日志声明所有端口都没听上", logs.includes("所有端口都无法监听"), "");
chkTrue("日志不再打印误导性的 listening", !/listening on [^\n]*/.test(logs), "");
chkTrue("日志提醒核对云托管控制台服务端口", logs.includes("服务端口"), "");

child.kill();
blocker.close();

// ---------- 场景 2：部分端口失败不能拖垮整体 ----------
// 线上平台探针打的是控制台配置的服务端口，而应用默认同时听 PORT(8080) 和 EXTRA_PORTS(80)，
// 就是为了兼容"服务端口被固定成 80 且改不了"的情况。
// 因此必须保证：一个端口被占，另一个端口仍然正常提供服务，进程不能退出。
console.log("\n----- 场景 2：主端口被占，额外端口仍可用 -----");
const { server: blocker2, port: BLOCKED } = await holdFreePort();
// FALLBACK 必须是空着的（要留给子进程真的绑上），所以借一个端口号立刻还回去。
const probe = await holdFreePort();
const FALLBACK = probe.port;
await new Promise(resolve => probe.server.close(resolve));

const child2 = spawn(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: {
    ...process.env,
    PORT: String(BLOCKED),
    EXTRA_PORTS: String(FALLBACK),
    NODE_ENV: "production",
    ADMIN_API_KEY: "bind-failure-test-key-0123456789",
    CLOUDBASE_ENV_ID: "test-nonexistent-env-for-bind-test",
    CLOUDBASE_APIKEY: "bogus-key"
  }
});
let logs2 = "";
child2.stdout.on("data", d => { logs2 += d.toString(); });
child2.stderr.on("data", d => { logs2 += d.toString(); });

let alive2 = true;
child2.on("exit", () => { alive2 = false; });

let fallbackOk = false;
const deadline2 = Date.now() + 8000;
while (Date.now() < deadline2) {
  try {
    const res = await fetch(`http://127.0.0.1:${FALLBACK}/api/health`);
    if (res.status === 200) { fallbackOk = true; break; }
  } catch { /* 还没起来，继续等 */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}

chkTrue("主端口失败时进程仍然存活", alive2, "");
chkTrue("日志报告主端口监听失败", logs2.includes(`监听 0.0.0.0:${BLOCKED} 失败`), "");
chkTrue("日志声明额外端口已监听", logs2.includes(`listening on 0.0.0.0:${FALLBACK}`), "");
chkTrue("额外端口能正常响应健康检查", fallbackOk, `http://127.0.0.1:${FALLBACK}/api/health`);

child2.kill();
blocker2.close();

console.log("----");
console.log(`bind-failure.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
