// T2-5 / T2-7 端到端压测：自己起服务、自己收尾，不依赖外部进程。
// 运行：node <本文件>
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 用测试文件自身位置推 api 目录，绝不能用 process.cwd()
//    （run-unit.mjs 从仓库根启动时会把 server.js 解析到仓库根，子进程秒退）。
const here = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(here, "..");
const PORT = 4899;
const BASE = `http://127.0.0.1:${PORT}`;

// 账号接口（建号/签令牌）要求服务端配了自定义登录私钥，自造一份。
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDS = Buffer.from(JSON.stringify({
  private_key_id: "e2e-key-id-0001", private_key: privateKey, env_id: "e2e-env-0001"
}), "utf8").toString("base64");

let pass = 0;
let fail = 0;
const chk = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} = ${JSON.stringify(actual)}${ok ? "" : "  期望=" + JSON.stringify(expected)}`);
  ok ? pass++ : fail++;
};

const server = spawn(process.execPath, ["server.js"], {
  cwd: API_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    EXTRA_PORTS: "0",
    NODE_ENV: "test",
    ADMIN_API_KEY: "t25-e2e-key-0123456789abcd",
    CLOUDBASE_CUSTOM_LOGIN_KEY: CREDS,
    CLOUDBASE_ENV_ID: ""
  }
});
let logs = "";
server.stdout.on("data", d => { logs += d.toString(); });
server.stderr.on("data", d => { logs += d.toString(); });

const deadline = Date.now() + 10000;
let up = false;
while (Date.now() < deadline) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 50));
}
if (!up) { console.log("服务没起来：\n" + logs); server.kill(); process.exit(1); }

const call = async (method, p, opts = {}) => {
  const h = { "content-type": "application/json" };
  if (opts.token) h.authorization = `Bearer ${opts.token}`;
  const r = await fetch(BASE + p, {
    method, headers: h,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const newAccount = async () => {
  const r = await call("POST", "/api/account/ticket", { body: {} });
  return { uid: r.body.data.uid, token: r.body.data.token };
};
const SAVE = bubbles => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: { fish001: 3 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});

try {
  // ===== A. 20 并发购买 =====
  console.log("\n--- A. 20 笔并发购买（应当笔笔落地）---");
  const acc = await newAccount();
  chk("首次推送 → 200", (await call("PUT", "/api/game/save", { token: acc.token, body: SAVE(5000) })).status, 200);

  const N = 20;
  const res = await Promise.all(Array.from({ length: N }, () =>
    call("POST", "/api/game/shop/buy", { token: acc.token, body: { itemId: "fish002" } })));
  const codes = {};
  for (const r of res) codes[r.status] = (codes[r.status] || 0) + 1;
  console.log(`   状态分布 = ${JSON.stringify(codes)}`);
  chk(`并发 ${N} 笔全部 200`, codes[200], N);

  const after = (await call("GET", "/api/game/save", { token: acc.token })).body.data.save;
  chk(`库存 fish002 = ${N}（不是 1）`, after.PlayerData.inventory.fish.fish002, N);
  chk(`泡泡 = ${5000 - N * 35}`, after.PlayerData.bubbles, 5000 - N * 35);

  // ===== B. 并发结算收敛 =====
  console.log("\n--- B. 5 条并发结算（最终必须收敛到同一目标态）---");
  const acc2 = await newAccount();
  await call("PUT", "/api/game/save", { token: acc2.token, body: SAVE(5000) });
  const target = {
    fish: [{ itemId: "fish001", instanceId: "a1" }, { itemId: "fish002", instanceId: "b1" }],
    decoration: "", background: "", sand: "", ambientSound: ""
  };
  const sres = await Promise.all(Array.from({ length: 5 }, () =>
    call("POST", "/api/game/shop/settle", { token: acc2.token, body: target })));
  const scodes = {};
  for (const r of sres) scodes[r.status] = (scodes[r.status] || 0) + 1;
  console.log(`   状态分布 = ${JSON.stringify(scodes)}`);
  chk("没有 500（并发结算不会把服务打崩）", scodes[500] || 0, 0);
  const a2 = (await call("GET", "/api/game/save", { token: acc2.token })).body.data.save;
  chk("最终库存 fish002 = 1（按差额算，不是按次数）", a2.PlayerData.inventory.fish.fish002, 1);
  chk("最终泡泡 = 4965（只扣一次 35）", a2.PlayerData.bubbles, 4965);
  chk("鱼缸收敛到 2 条", a2.AquariumData.fish.length, 2);

  // ===== C. 并发专注结算（T2-7：会话落库 + CAS 防重放）=====
  console.log("\n--- C. 同一 sessionId 并发结算（CAS 只允许一次）---");
  const acc3 = await newAccount();
  await call("PUT", "/api/game/save", { token: acc3.token, body: SAVE(100) });
  const started = await call("POST", "/api/game/focus/start", { token: acc3.token, body: { plannedMinutes: 25 } });
  chk("开始专注 → 201", started.status, 201);
  const sid = started.body.data.sessionId;
  const cres = await Promise.all(Array.from({ length: 6 }, () =>
    call("POST", "/api/game/focus/complete", { token: acc3.token, body: { sessionId: sid } })));
  const c200 = cres.filter(r => r.status === 200).length;
  const c404 = cres.filter(r => r.status === 404).length;
  console.log(`   状态分布 = ${JSON.stringify(cres.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {}))}`);
  chk("恰好一次结算成功（奖励不能重复领）", c200, 1);
  chk("其余全部 404", c404, 5);

  // ===== D. 跨实例结算（T2-7 的核心：内存 Map 之外还有权威源）=====
  console.log("\n--- D. 跨实例：换一个账号、模拟「另一台实例」结算 ---");
  const acc4 = await newAccount();
  await call("PUT", "/api/game/save", { token: acc4.token, body: SAVE(100) });
  const s4 = await call("POST", "/api/game/focus/start", { token: acc4.token, body: { plannedMinutes: 25 } });
  const sid4 = s4.body.data.sessionId;

  // 用另一个账号的令牌去结算 → 必须 403（归属校验）
  const stranger = await newAccount();
  const stolen = await call("POST", "/api/game/focus/complete", { token: stranger.token, body: { sessionId: sid4 } });
  chk("别人的令牌结算 → 403（会话有主人）", stolen.status, 403);
  chk("错误码 SESSION_OWNER_MISMATCH", stolen.body.code, "SESSION_OWNER_MISMATCH");

  // 本人仍然能结算（被拒的那次没有把会话消费掉）
  const mine = await call("POST", "/api/game/focus/complete", { token: acc4.token, body: { sessionId: sid4 } });
  chk("被拒之后本人仍能结算 → 200", mine.status, 200);

  // ===== E. 探针在没开 FISHTANK_DIAG 时必须 404 =====
  console.log("\n--- E. 诊断探针门禁 ---");
  const probe = await call("GET", "/api/debug/req");
  chk("没开 FISHTANK_DIAG → 探针 404（生产永不注册）", probe.status, 404);

  // ===== F. ready 探针 =====
  console.log("\n--- F. /api/ready ---");
  const ready = await call("GET", "/api/ready");
  chk("内存数据层 → /api/ready 200", ready.status, 200);
  chk("ready=true", ready.body.ready, true);
  chk("报出 driver", ready.body.database.driver, "memory");
} finally {
  server.kill();
}

console.log(`\n===== t25-e2e: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
