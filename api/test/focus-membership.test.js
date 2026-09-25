// 专注奖励的会员标记必须由服务端裁定。
//
// 这里锁的 bug（09-25 线上核实）：
//   focus/start 原来是 focusSessions.start(req.body) —— isMember 直接取自客户端请求体；
//   前端本来就把它当可写字段（DEV 面板有「切换会员」，存档推送里也带着它）。
//   线上梯度 25min 是 normal=1 / member=2，于是同样 25 分钟：
//     正常 25 泡泡 → 谎报会员 50 泡泡，直接翻倍。
//   云存档那条路一直是服务端权威（player-store.js 的 mergeSave 会丢掉客户端的 isMember），
//   只有专注结算这条路漏了。
//
// 修法：isMember 改由 resolveServerMembership() 从服务端存档读；未登录 / 查不到 / 出错一律按非会员。
// 运行：node test/focus-membership.test.js
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const serverSource = fs.readFileSync(path.join(apiDir, "server.js"), "utf8").replace(/\r\n/g, "\n");

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

// 花括号配对抽函数。⚠️ 必须保留 async 前缀，否则函数体里的 await 会变成语法错误。
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`server.js 里找不到函数 ${name}`);
  const head = src.slice(Math.max(0, start - 6), start) === "async " ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(head, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

// 在沙箱里跑真实实现，只注入 getPlayerStore。
function buildResolver(getPlayerStore) {
  const factory = new Function(
    "getPlayerStore",
    `${extractFunction(serverSource, "resolveServerMembership")}\nreturn resolveServerMembership;`
  );
  return factory(getPlayerStore);
}
const saveWith = isMember => ({ data: { PlayerData: { bubbles: 100, isMember, inventory: {} } } });

console.log("--- 1. 会员标记以服务端存档为准 ---");
{
  chk("存档里 isMember=true → true", await buildResolver(async () => ({ getSave: async () => saveWith(true) }))({ uid: "u1" }), true);
  chk("存档里 isMember=false → false", await buildResolver(async () => ({ getSave: async () => saveWith(false) }))({ uid: "u1" }), false);
}

console.log("\n--- 2. 查不到就按非会员，绝不放行 ---");
{
  chk("未登录（auth.error）→ false",
    await buildResolver(async () => { throw new Error("不该被调用"); })({ error: "缺少令牌", uid: "" }), false);
  chk("auth 是 null → false",
    await buildResolver(async () => { throw new Error("不该被调用"); })(null), false);
  chk("auth 是 undefined → false",
    await buildResolver(async () => { throw new Error("不该被调用") })(undefined), false);
  chk("还没有云存档 → false",
    await buildResolver(async () => ({ getSave: async () => null }))({ uid: "u1" }), false);
  chk("存档结构不全 → false",
    await buildResolver(async () => ({ getSave: async () => ({ data: {} }) }))({ uid: "u1" }), false);
  chk("isMember 是字符串 \"true\" → false（只认布尔 true）",
    await buildResolver(async () => ({ getSave: async () => saveWith("true") }))({ uid: "u1" }), false);
  chk("存档层抛错 → false（不是 500，也不是放行）",
    await buildResolver(async () => { throw new Error("db down"); })({ uid: "u1" }), false);
  chk("getSave 抛错 → false",
    await buildResolver(async () => ({ getSave: async () => { throw new Error("timeout"); } }))({ uid: "u1" }), false);
}

console.log("\n--- 3. 静态锚：focus/start 不再把 body 直接交给会话 ---");
{
  chkTrue("旧写法 focusSessions.start(req.body) 已不存在",
    !/focusSessions\.start\(\s*req\.body\s*\)/.test(serverSource));
  chkTrue("改为显式传 plannedMinutes + isMember",
    /focusSessions\.start\(\{\s*plannedMinutes:[\s\S]{0,80}isMember\s*\}\)/.test(serverSource));
  chkTrue("isMember 来自 resolveServerMembership(auth)",
    /const isMember = await resolveServerMembership\(auth\);\s*\n\s*const session = focusSessions\.start\(/.test(serverSource));
  // 反向：isMember 不能又从 body 里冒出来。
  chkTrue("源码里没有把 body.isMember 交给会话的地方",
    !/isMember:\s*(req\.body|body)\.isMember/.test(serverSource));
}

console.log("\n--- 4. HTTP 冒烟：接口形状没被改坏 ---");
let nextPort = 5300 + Math.floor(Math.random() * 200);
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const credentialsBase64 = Buffer.from(JSON.stringify({
  private_key_id: "self-test-key-id-membership",
  private_key: privateKey,
  env_id: "self-test-env-membership"
}), "utf8").toString("base64");

const port = nextPort++;
const server = spawn(process.execPath, ["server.js"], {
  cwd: apiDir,
  env: {
    ...process.env,
    PORT: String(port),
    EXTRA_PORTS: "0",
    NODE_ENV: "test",
    ADMIN_API_KEY: "focus-membership-test-key-0123456789",
    CLOUDBASE_ENV_ID: "",
    CLOUDBASE_CUSTOM_LOGIN_KEY: credentialsBase64
  }
});
const base = `http://127.0.0.1:${port}`;
try {
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 50));
  }
  chkTrue("服务起来了", up);

  const call = async (method, urlPath, { token, body } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const account = (await call("POST", "/api/account/ticket", { body: {} })).body.data || {};
  chkTrue("建号拿到令牌", Boolean(account.token));

  // 谎报会员：仍然能开始专注（登录不是专注的前提），但服务端不再采信这个字段。
  const lie = await call("POST", "/api/game/focus/start", { token: account.token, body: { plannedMinutes: 25, isMember: true } });
  chk("谎报会员照常开始专注 → 201", lie.status, 201);
  chk("回包仍带 sessionId", typeof (lie.body.data || {}).sessionId, "string");
  chk("回包仍回显 plannedMinutes = 25", (lie.body.data || {}).plannedMinutes, 25);
  chkTrue("回包不泄露会员标记（不给出可利用的反馈）", !("isMember" in (lie.body.data || {})));

  // 未登录也能专注 —— 这条不能被本次修改破坏。
  const anon = await call("POST", "/api/game/focus/start", { body: { plannedMinutes: 25, isMember: true } });
  chk("未登录也能开始专注 → 201", anon.status, 201);

  // 参数校验仍在 isMember 处理之前。
  const bad = await call("POST", "/api/game/focus/start", { token: account.token, body: { plannedMinutes: 7, isMember: true } });
  chk("非法时长仍被拒 → 400", bad.status, 400);
} finally {
  server.kill();
}

console.log(`\n===== 专注会员标记测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
