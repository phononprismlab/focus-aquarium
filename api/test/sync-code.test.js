// 跨设备同步码的回归测试。
//
// 这个文件盯的是**凭证边界**，不是功能是否跑通。四件事：
//   1) 同步码与会话令牌是两种凭证，密钥分开派生 —— 拿到同步码不能当令牌用，反之亦然。
//      否则「给玩家抄走的码」就等于是把 180 天的令牌交出去了。
//   2) 同步码只有 10 分钟：它会被复制、粘贴、可能截图，绝不能做成长期凭证。
//   3) 生成码要身份，兑换码不要身份 —— 但兑换是**唯一一个没有身份就能调用的账号接口**，
//      所以它必须有别的约束（码本身无法伪造 + 限流）。
//   4) 🔴 前端接管后必须把「本地上次推送时间」清零，否则「恢复」会变成「覆盖」，
//      刚恢复的原设备存档会被这台设备的本地存档顶掉。
//
// 全程内存仓库 + 内存玩家数据层，不连任何云环境。
// 运行：node test/sync-code.test.js
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { issueSyncCode, verifySyncCode, syncCodeStatus, SYNC_CODE_TTL_MS, resetSyncCodeKeyCache } from "../sync-code.js";
import { issueSessionToken, verifySessionToken, resetSessionSecretCache } from "../session-token.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");
const repoRoot = path.join(here, "..", "..");

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

// 两个模块都缓存密钥，改环境变量后必须一起清，否则读到的是上一次的。
function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSessionSecretCache();
  resetSyncCodeKeyCache();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSessionSecretCache();
    resetSyncCodeKeyCache();
  }
}

const TEST_KEY = "sync-code-test-key-0123456789";

// ============================================================
console.log("--- 1. 同步码的签发与校验 ---");
// ============================================================
{
  const issued = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSyncCode("u_sync_test_0001"));
  chkTrue("签发成功", typeof issued.code === "string" && issued.code.length > 0);
  chkTrue("码以 s1. 开头（一眼能看出这不是会话令牌）", issued.code.startsWith("s1."), issued.code.slice(0, 6));
  chkTrue("10 分钟有效期", SYNC_CODE_TTL_MS === 10 * 60 * 1000, String(SYNC_CODE_TTL_MS));

  const verified = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode(issued.code));
  chk("验签拿回同一个 uid", verified.uid, "u_sync_test_0001");
  chkTrue("没有 error", verified.error === undefined);

  chkTrue("缺 uid 时拒绝签发", Boolean(withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSyncCode("").error)));
  chkTrue("没配密钥时拒绝签发", Boolean(withEnv({ ADMIN_API_KEY: undefined }, () => issueSyncCode("u_x").error)));
  chkTrue("没配密钥时拒绝验签", Boolean(withEnv({ ADMIN_API_KEY: undefined }, () => verifySyncCode("s1.a.b").error)));
  chk("没配密钥时状态为 configured:false", withEnv({ ADMIN_API_KEY: undefined }, () => syncCodeStatus().configured), false);
  chk("配了密钥时状态为 configured:true", withEnv({ ADMIN_API_KEY: TEST_KEY }, () => syncCodeStatus().configured), true);
}

// ============================================================
console.log("\n--- 2. 两种凭证不能互相通用 ---");
// ============================================================
{
  const { code } = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSyncCode("u_sync_test_0001"));
  const { token } = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSessionToken("u_sync_test_0001"));

  // 同步码拿去当会话令牌用：verifySessionToken 只认 v1 前缀。
  const asToken = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySessionToken(code));
  chkTrue("同步码不能当会话令牌用", Boolean(asToken.error), asToken.error);

  // 会话令牌拿去当同步码用：要给一句人话，而不是笼统的「验签失败」。
  const asCode = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode(token));
  chkTrue("会话令牌不能当同步码用", Boolean(asCode.error), asCode.error);
  chkTrue("并且说清楚它是什么（不是笼统的验签失败）", (asCode.error || "").includes("不是同步码"), asCode.error);
}

// ============================================================
console.log("\n--- 3. 过期 / 篡改 / 格式 ---");
// ============================================================
{
  const expired = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSyncCode("u_sync_test_0001", { ttlMs: -1000 }));
  const result = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode(expired.code));
  chkTrue("过期的码验签失败", Boolean(result.error), result.error);
  chk("并且标了 expired（前端据此提示重新生成）", result.expired, true);

  const good = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSyncCode("u_sync_test_0001"));
  const parts = good.code.split(".");
  const tamperedBody = [parts[0], parts[1].slice(0, -4) + "AAAA", parts[2]].join(".");
  chkTrue("改 payload → 验签失败", Boolean(withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode(tamperedBody).error)));
  const tamperedSig = [parts[0], parts[1], parts[2].slice(0, -4) + "AAAA"].join(".");
  chkTrue("改签名 → 验签失败", Boolean(withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode(tamperedSig).error)));

  chkTrue("空码 → 拒绝", Boolean(withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode("").error)));
  chkTrue("段数不对 → 拒绝", Boolean(withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode("s1.onlytwo").error)));
  chkTrue("未知版本 → 拒绝", Boolean(withEnv({ ADMIN_API_KEY: TEST_KEY }, () => verifySyncCode("s9.a.b").error)));
}

// ============================================================
console.log("\n--- 4. HTTP：生成码要身份，兑换码不要 ---");
// ============================================================
let portSeq = 26800;
const takePort = () => portSeq++;

const startServer = async () => {
  const port = takePort();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: TEST_KEY,
      // 不设 CLOUDBASE_ENV_ID：走内存仓库 + 内存玩家数据层，测试不连云环境。
      CLOUDBASE_ENV_ID: ""
    }
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${base}/api/health`); if (res.ok) return { server, base }; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 50));
  }
  server.kill();
  throw new Error(`服务没能在 10s 内起来（port ${port}）`);
};

const call = async (base, method, urlPath, { token, body } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

{
  const { server, base } = await startServer();
  try {
    // 测试进程与服务进程用同一个 ADMIN_API_KEY，所以本进程签的令牌服务端认。
    const mine = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSessionToken("u_sync_test_0001"));

    const noToken = await call(base, "POST", "/api/game/sync/code");
    chk("没令牌生成码 → 401", noToken.status, 401);

    const ok = await call(base, "POST", "/api/game/sync/code", { token: mine.token });
    chk("有令牌生成码 → 200", ok.status, 200);
    chkTrue("返回了码", typeof ok.body.data?.code === "string" && ok.body.data.code.startsWith("s1."));
    chkTrue("返回了过期时间", Number(ok.body.data?.expiresAt) > Date.now());

    const code = ok.body.data.code;

    // 兑换：绝不能带令牌 —— 来兑换的人一个凭证都没有。
    const redeemed = await call(base, "POST", "/api/account/sync/redeem", { body: { code } });
    chk("兑换（不带任何令牌）→ 200", redeemed.status, 200);
    chk("兑换拿回同一个 uid", redeemed.body.data?.uid, "u_sync_test_0001");
    chkTrue("兑换拿到了会话令牌", typeof redeemed.body.data?.token === "string" && redeemed.body.data.token.length > 0);
    chk("旧设备令牌照样有效（不踢下线）", redeemed.body.data?.previousDeviceStillValid, true);

    // 兑换来的令牌要真的能用：不是发个好看的字符串。
    const saveRead = await call(base, "GET", "/api/game/save", { token: redeemed.body.data.token });
    chk("兑换来的令牌能读存档", saveRead.status, 200);

    const empty = await call(base, "POST", "/api/account/sync/redeem", { body: {} });
    chk("不传码 → 400", empty.status, 400);
    chkTrue("400 说清缺什么", (empty.body.error || "").includes("同步码"), empty.body.error);

    const tampered = await call(base, "POST", "/api/account/sync/redeem", { body: { code: code.slice(0, -4) + "AAAA" } });
    chk("篡改过的码 → 400", tampered.status, 400);

    const expiredCode = withEnv({ ADMIN_API_KEY: TEST_KEY }, () => issueSyncCode("u_sync_test_0001", { ttlMs: -1000 })).code;
    const expired = await call(base, "POST", "/api/account/sync/redeem", { body: { code: expiredCode } });
    chk("过期的码 → 410", expired.status, 410);

    const wrongKind = await call(base, "POST", "/api/account/sync/redeem", { body: { code: mine.token } });
    chk("拿会话令牌当同步码 → 400", wrongKind.status, 400);
  } finally {
    server.kill();
  }
}

// ============================================================
console.log("\n--- 5. 前端：接管的每一步都不能走样 ---");
// ============================================================
const source = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
const norm = text => text.replace(/\r\n/g, "\n");

// 剥注释。⚠️ 不能用正则一把梭：注释正文里出现 `/api/game/*` 这类片段时，其中的
// `/*` 会被当成块注释起点，把后面大段代码一路吞掉。逐字符扫描，并跳过字符串字面量。
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === ch) { j += 1; break; }
        if (text[j] === "\n" && ch !== "`") { break; }
        j += 1;
      }
      if (j > i + 1 && text[j - 1] === ch) { out += text.slice(i, j); i = j; continue; }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const playerRaw = norm(source);
const playerCode = stripComments(playerRaw);

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html 里找不到函数 ${name}`);
  const isAsync = src.slice(Math.max(0, start - 6), start) === "async ";
  const begin = isAsync ? start - 6 : start;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(begin, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}

{
  for (const id of ["syncCodeBtn", "syncCodeText", "syncCodeCopy", "syncRedeemBtn", "syncRedeemText", "syncRedeemGo"]) {
    chkTrue(`UI 有 #${id}`, source.includes(`id="${id}"`));
  }

  const gen = extractFunction(playerCode, "generateSyncCode");
  chkTrue("生成走 POST /game/sync/code", gen.includes("${API_BASE}/game/sync/code") && gen.includes('method:"POST"'));
  chkTrue("生成带令牌（cloudHeaders）", gen.includes("headers:cloudHeaders()"));
  chkTrue("云同步没开时不白跑一趟（先检查开关）", /if\(!CLOUD_SYNC_ENABLED\|\|!ACCOUNT_TOKEN\)/.test(gen));
  chkTrue("服务端没给码时当失败处理", gen.includes('throw new Error("服务端没有返回同步码")'));

  const redeem = extractFunction(playerCode, "redeemSyncCode");
  chkTrue("兑换走 POST /account/sync/redeem", redeem.includes("${API_BASE}/account/sync/redeem"));
  chkTrue("兑换不带令牌（来兑换的人此刻没有凭证）", redeem.includes('headers:{ "Content-Type":"application/json" }'));
  chkTrue("兑换提交 code", redeem.includes("JSON.stringify({ code })"));
  chkTrue("落盘 uid 与令牌", redeem.includes("localStorage.setItem(ACCOUNT_UID_KEY,data.uid)") && redeem.includes("localStorage.setItem(ACCOUNT_TOKEN_KEY,data.token)"));
  chkTrue("响应缺 token/uid 时抛错（不造出用不了的账号）", redeem.includes('throw new Error("恢复响应不完整，请重试")'));
  chkTrue("接管后开启云同步", redeem.includes("CLOUD_SYNC_ENABLED=true"));
  chkTrue("接管后触发同步（拉回原设备存档）", redeem.includes("await syncCloudSave()"));
  // 🔴 最容易漏的一条：不清零的话 syncCloudSave 会判定「本地更新」把本地推上去，
  //    「恢复」就变成了「覆盖」，原设备的存档被这台设备的本地存档顶掉。
  chkTrue("接管后把本地推送时间清零（否则恢复变成覆盖）", redeem.includes("markPushed(0)"));

  const anchor = redeem.indexOf("markPushed(0)");
  const syncAt = redeem.indexOf("await syncCloudSave()");
  chkTrue("清零发生在同步之前", anchor >= 0 && syncAt > anchor, `markPushed L${anchor} < syncCloudSave L${syncAt}`);

  chkTrue("生成按钮兜住了 Promise", /getElementById\("syncCodeBtn"\)\.addEventListener\("click",\(\)=>\{[\s\S]{0,120}generateSyncCode\(\)\s*\.catch\(/.test(playerCode));
  chkTrue("恢复按钮兜住了 Promise", /getElementById\("syncRedeemGo"\)\.addEventListener\("click",\(\)=>\{[\s\S]{0,120}redeemSyncCode\(\)\s*\.catch\(/.test(playerCode));
}

console.log(`\n----\nsync-code.test: PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
