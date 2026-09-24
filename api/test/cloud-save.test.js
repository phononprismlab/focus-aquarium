// 云存档与身份令牌的回归测试。
//
// 这个文件盯的是**安全边界**，不是功能是否跑通。三件事：
//   1) 会话令牌：只有服务端签的令牌能证明「我是这个 uid」。
//      uid 会出现在 localStorage / 网络面板 / 用户截图里，它**不是凭证**。
//   2) 存档合并的分权：库存与会员标记服务端权威，泡泡与布局客户端权威。
//      写反了任何一半都会出问题 —— 前者是「改个请求就能白嫖商品」，
//      后者是「玩家的鱼缸布置存不下来」。
//   3) 鱼缸布局不是白嫖通道：鱼的条数不能超过库存、选中的装扮必须已拥有。
//      这两条不校验的话，「服务端权威的库存」就形同虚设。
//
// 全程自造 RSA 私钥 + 内存仓库/内存玩家数据层，不连任何云环境。
// 运行：node test/cloud-save.test.js
import crypto from "node:crypto";
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

// 环境变量必须在**导入模块之前**摆好，且导入后要清一次密钥缓存 ——
// session-token.js 会缓存解析结果，否则第二条断言读到的还是第一条的密钥。
function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSessionSecretCache();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSessionSecretCache();
  }
}

const { issueSessionToken, verifySessionToken, sessionSecretStatus, resetSessionSecretCache } =
  await import("../session-token.js");
const { mergeSaveForWrite, planPurchase, planSettlement, MAX_BUBBLE_GAIN_PER_PUSH } =
  await import("../player-store.js");

// ===== 1. 令牌密钥的来源 =====
console.log("\n--- 1. 会话令牌：密钥来源 ---");
withEnv({ FISHTANK_SESSION_SECRET: "explicit-secret-0123456789", ADMIN_API_KEY: "admin-key-0123456789" }, () => {
  chk("显式配置优先", sessionSecretStatus().source, "explicit");
});
withEnv({ FISHTANK_SESSION_SECRET: undefined, ADMIN_API_KEY: "admin-key-0123456789" }, () => {
  chk("没配专用密钥时从管理密钥派生（零配置可用）", sessionSecretStatus().source, "derived");
});
withEnv({ FISHTANK_SESSION_SECRET: undefined, ADMIN_API_KEY: undefined }, () => {
  chk("两样都没有 → none", sessionSecretStatus().source, "none");
  chkTrue("没有密钥时拒绝签发（而不是签一个谁都能伪造的）", Boolean(issueSessionToken("u_test").error));
  chkTrue("没有密钥时拒绝校验", Boolean(verifySessionToken("v1.a.b").error));
});

// ===== 2. 令牌的签发与校验 =====
console.log("\n--- 2. 会话令牌：签发、校验、篡改 ---");
withEnv({ FISHTANK_SESSION_SECRET: "secret-a", ADMIN_API_KEY: undefined }, () => {
  const T0 = 1700000000000;
  const issued = issueSessionToken("u_round_trip", { now: T0 });
  chkTrue("签发成功", typeof issued.token === "string" && issued.token.length > 0);
  chk("令牌是三段式（v1.载荷.签名）", issued.token.split(".").length, 3);
  chkTrue("令牌里不含密钥原文", !issued.token.includes("secret-a"));

  const verified = verifySessionToken(issued.token, { now: T0 + 1000 });
  chk("往返校验拿回同一个 uid", verified.uid, "u_round_trip");
  chk("过期时间透传", verified.expiresAt, issued.expiresAt);

  // 派生是确定性的：同样的密钥 + 同样的时刻 → 同样的令牌。
  // 这条顺带证明「令牌不是随机的」，也就是说服务端重启后旧令牌依然有效。
  resetSessionSecretCache();
  chk("同一密钥同一时刻可复现（服务端重启不会让旧令牌失效）",
    issueSessionToken("u_round_trip", { now: T0 }).token, issued.token);

  const parts = issued.token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ uid: "u_hacker", iat: 1, exp: 9e15 })).toString("base64url");
  chkTrue("改载荷但沿用原签名 → 拒绝", Boolean(verifySessionToken(`v1.${forgedPayload}.${parts[2]}`, { now: T0 }).error));
  chkTrue("改签名 → 拒绝", Boolean(verifySessionToken(`${parts[0]}.${parts[1]}.AAAAAAAA`, { now: T0 }).error));
  chkTrue("截断签名 → 拒绝", Boolean(verifySessionToken(`${parts[0]}.${parts[1]}.AA`, { now: T0 }).error));
  chkTrue("版本不对 → 拒绝", Boolean(verifySessionToken("v9.a.b", { now: T0 }).error));
  chkTrue("不是令牌 → 拒绝", Boolean(verifySessionToken("garbage", { now: T0 }).error));
  chkTrue("空串 → 拒绝", Boolean(verifySessionToken("", { now: T0 }).error));
  chkTrue("null → 拒绝", Boolean(verifySessionToken(null, { now: T0 }).error));

  const expired = verifySessionToken(issued.token, { now: issued.expiresAt + 1 });
  chkTrue("过期 → 明确报 expired（前端据此重新建号，而不是当成服务器故障）", expired.expired === true, expired.error);
});
withEnv({ FISHTANK_SESSION_SECRET: "secret-a", ADMIN_API_KEY: undefined }, () => {
  const a = issueSessionToken("u_a", { now: 1700000000000 }).token;
  resetSessionSecretCache();
  withEnv({ FISHTANK_SESSION_SECRET: "secret-b", ADMIN_API_KEY: undefined }, () => {
    chkTrue("换密钥后旧令牌立刻失效", Boolean(verifySessionToken(a, { now: 1700000000000 }).error));
  });
});

// ===== 3. 存档合并：经济字段分权 =====
console.log("\n--- 3. 存档合并：库存与会员服务端权威，泡泡客户端权威 ---");
const baseSave = () => ({
  saveVersion: "0.2.0",
  PlayerData: {
    bubbles: 100,
    isMember: false,
    inventory: { fish: { fish001: 3 }, decorations: {}, backgrounds: { background001: 1 }, sands: {}, sounds: {} }
  },
  AquariumData: { fish: [{ itemId: "fish001", instanceId: "f1" }], decoration: "", background: "background001", sand: "", ambientSound: "" },
  Settings: { audio: { bgm: 38 } }
});
{
  const first = mergeSaveForWrite(null, baseSave());
  chk("首次推送：接受客户端的泡泡（本地才是他的真实进度）", first.save.PlayerData.bubbles, 100);
  chk("首次推送：接受客户端的库存", first.save.PlayerData.inventory.fish.fish001, 3);
  chk("首次推送标记 firstPush", first.firstPush, true);
}
{
  const stored = baseSave();
  const incoming = baseSave();
  incoming.PlayerData = { bubbles: 120, isMember: true, inventory: { fish: { fish001: 999 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } };
  const merged = mergeSaveForWrite(stored, incoming);
  chk("库存以服务端为准（客户端改不动）", merged.save.PlayerData.inventory.fish.fish001, 3);
  chk("会员标记以服务端为准（客户端自己开不了）", merged.save.PlayerData.isMember, false);
  chk("泡泡接受客户端的（增量在上限内）", merged.save.PlayerData.bubbles, 120);
  chk("不再标记 firstPush", merged.firstPush, false);
  chkTrue("记录了被忽略的 inventory", merged.problems.some(p => p.includes("inventory")), merged.problems.join(" / "));
  chkTrue("记录了被忽略的 isMember", merged.problems.some(p => p.includes("isMember")));
}
{
  const incoming = baseSave();
  incoming.PlayerData = { ...baseSave().PlayerData, bubbles: 999999 };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("泡泡暴涨被截断到「服务端值 + 单次上限」", merged.save.PlayerData.bubbles, 100 + MAX_BUBBLE_GAIN_PER_PUSH);
  chkTrue("截断有记录", merged.problems.some(p => p.includes("增量超过单次上限")));
}
{
  const incoming = baseSave();
  incoming.PlayerData = { ...baseSave().PlayerData, bubbles: 80 };
  chk("泡泡减少照常放行（买完要能把更小的值推上来）", mergeSaveForWrite(baseSave(), incoming).save.PlayerData.bubbles, 80);
}
{
  const incoming = baseSave();
  incoming.PlayerData = { ...baseSave().PlayerData, bubbles: -50 };
  chk("负数泡泡归零而不是写成 NaN", mergeSaveForWrite(baseSave(), incoming).save.PlayerData.bubbles, 0);
}
{
  const incoming = baseSave();
  incoming.PlayerData = { ...baseSave().PlayerData, bubbles: "abc" };
  chk("非数字泡泡归零（NaN 会一路传染到「🫧 NaN」）", mergeSaveForWrite(baseSave(), incoming).save.PlayerData.bubbles, 0);
}

// ===== 4. 鱼缸布局不能变成白嫖通道 =====
console.log("\n--- 4. 存档合并：鱼缸布局不是白嫖通道 ---");
{
  const incoming = baseSave();
  incoming.AquariumData = { ...baseSave().AquariumData, fish: Array.from({ length: 10 }, (_, i) => ({ itemId: "fish001", instanceId: `x${i}` })) };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("超出库存的鱼被丢弃（库存只有 3 条）", merged.save.AquariumData.fish.length, 3);
  chkTrue("丢弃有记录", merged.problems.some(p => p.includes("超出库存")));
}
{
  const incoming = baseSave();
  incoming.AquariumData = { ...baseSave().AquariumData, fish: [{ itemId: "fish999", instanceId: "ghost" }] };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("完全没买过的鱼种 → 一条也摆不上", merged.save.AquariumData.fish.length, 0);
}
{
  const incoming = baseSave();
  incoming.AquariumData = { ...baseSave().AquariumData, fish: [], background: "background002" };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("选中没买过的背景 → 保留服务端原值", merged.save.AquariumData.background, "background001");
  chkTrue("有记录", merged.problems.some(p => p.includes("不在库存里")));
}
{
  const incoming = baseSave();
  incoming.AquariumData = { ...baseSave().AquariumData, fish: [], background: "background001" };
  chk("选中已拥有的背景 → 放行", mergeSaveForWrite(baseSave(), incoming).save.AquariumData.background, "background001");
}
{
  const incoming = baseSave();
  incoming.AquariumData = { ...baseSave().AquariumData, fish: [], sand: "sand002" };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("选中没买过的沙 → 回落到空", merged.save.AquariumData.sand, "");
}
{
  const incoming = baseSave();
  incoming.Settings = { audio: { bgm: 9999, sfx: -50 } };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("音量上限钳到 100", merged.save.Settings.audio.bgm, 100);
  chk("音量下限钳到 0", merged.save.Settings.audio.sfx, 0);
}
{
  const incoming = baseSave();
  delete incoming.Settings;
  chk("客户端没提交 Settings → 保留服务端原值", mergeSaveForWrite(baseSave(), incoming).save.Settings.audio.bgm, 38);
}

// ===== 5. 购买 =====
console.log("\n--- 5. 购买：经济数据的唯一合法写入路径 ---");
{
  const item = { id: "decoration001", name: "水草", category: "decorations", price: 20, maxInventory: 1 };
  const plan = planPurchase({ save: baseSave(), item, ownedCount: 0 });
  chk("扣掉泡泡", plan.save.PlayerData.bubbles, 80);
  chk("加上库存", plan.save.PlayerData.inventory.decorations.decoration001, 1);
  chk("返回实付价", plan.paid, 20);
  chk("返回新余额", plan.balance, 80);
  chk("返回新持有数", plan.ownedCount, 1);
}
{
  const item = { id: "fish003", name: "金色小鱼", category: "fish", price: 45, maxInventory: 50 };
  const plan = planPurchase({ save: baseSave(), item, ownedCount: 0 });
  chk("新鱼种记 1 条", plan.save.PlayerData.inventory.fish.fish003, 1);
  chk("原有库存不丢", plan.save.PlayerData.inventory.fish.fish001, 3);
}
{
  const item = { id: "background002", name: "深海夜色", category: "backgrounds", price: 500, maxInventory: 1 };
  const plan = planPurchase({ save: baseSave(), item, ownedCount: 0 });
  chk("泡泡不够 → INSUFFICIENT", plan.code, "INSUFFICIENT");
  chk("给出还差多少（前端要显示「还差 N」）", plan.short, 400);
  chkTrue("不返回新存档（失败的购买不能改动任何东西）", plan.save === undefined);
}
{
  const item = { id: "decoration001", name: "水草", category: "decorations", price: 20, maxInventory: 1 };
  chk("已养满 → FULL", planPurchase({ save: baseSave(), item, ownedCount: 1 }).code, "FULL");
}
{
  chk("没有存档 → NO_SAVE", planPurchase({ save: null, item: { id: "a", category: "fish", price: 1 }, ownedCount: 0 }).code, "NO_SAVE");
  chk("分类非法 → BAD_CATEGORY", planPurchase({ save: baseSave(), item: { id: "a", category: "nope", price: 1 }, ownedCount: 0 }).code, "BAD_CATEGORY");
  chk("价格非法 → BAD_PRICE", planPurchase({ save: baseSave(), item: { id: "a", category: "fish", price: "abc" }, ownedCount: 0 }).code, "BAD_PRICE");
  chk("价格缺失 → BAD_PRICE", planPurchase({ save: baseSave(), item: { id: "a", category: "fish" }, ownedCount: 0 }).code, "BAD_PRICE");
}
{
  // 价格只认服务端传进来的 item.price —— 客户端报的价格根本不进这个函数。
  const item = { id: "background002", name: "深海夜色", category: "backgrounds", price: 60, maxInventory: 1 };
  const plan = planPurchase({ save: baseSave(), item, ownedCount: 0 });
  chk("按服务端价格扣费（60 而不是客户端说的 1）", plan.paid, 60);
  chk("余额按服务端价格算", plan.balance, 40);
}

// ===== 6–8. HTTP 层 =====
// ⚠️ 端口随机：上一轮若有服务没被 kill，会一直占着端口，新实例绑不上，
//    健康检查就会连到**旧**服务上，断言被污染。
let nextPort = 4700 + Math.floor(Math.random() * 300);
const takePort = () => nextPort++;

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
const KEY_ENV = "self-test-env-0001";
const credentials = { private_key_id: "self-test-key-id-0001", private_key: privateKey, env_id: KEY_ENV };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: "cloud-save-test-key-0123456789",
      // 不设 CLOUDBASE_ENV_ID：走内存仓库 + 内存玩家数据层，测试不连云环境。
      CLOUDBASE_ENV_ID: "",
      [CREDENTIALS_ENV]: credentialsBase64,
      ...extraEnv
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

const newAccount = async base => {
  const res = await call(base, "POST", "/api/account/ticket", { body: {} });
  return { uid: res.body.data?.uid, token: res.body.data?.token, status: res.status };
};

console.log("\n--- 6. HTTP：云存档需要身份 ---");
{
  const { server, base } = await startServer({}, takePort());
  try {
    const noToken = await call(base, "GET", "/api/game/save");
    chk("没令牌读存档 → 401", noToken.status, 401);
    chkTrue("401 说清缺什么", (noToken.body.error || "").includes("会话令牌"), noToken.body.error);

    const badToken = await call(base, "GET", "/api/game/save", { token: "v1.forged.sig" });
    chk("伪造令牌读存档 → 401", badToken.status, 401);

    const noTokenPut = await call(base, "PUT", "/api/game/save", { body: baseSave() });
    chk("没令牌写存档 → 401", noTokenPut.status, 401);

    const noTokenBuy = await call(base, "POST", "/api/game/shop/buy", { body: { itemId: "decoration001" } });
    chk("没令牌购买 → 401", noTokenBuy.status, 401);

    const noTokenMe = await call(base, "GET", "/api/game/me");
    chk("没令牌读资料 → 401", noTokenMe.status, 401);

    const health = await (await fetch(`${base}/api/health`)).json();
    chk("health 里有 playerStore 状态", health.playerStore, "ok");
    chk("health 里有会话密钥来源（配错时唯一的线索）", health.sessionKey, "derived");
  } finally { server.kill(); }
}

console.log("\n--- 7. HTTP：存档读写与分权 ---");
{
  const { server, base } = await startServer({}, takePort());
  try {
    const account = await newAccount(base);
    chkTrue("建号拿到 uid", Boolean(account.uid), account.uid);
    chkTrue("建号拿到会话令牌", Boolean(account.token));

    const before = await call(base, "GET", "/api/game/save", { token: account.token });
    chk("新账号还没有云存档 → exists=false", before.body.data?.exists, false);
    chk("且不伪造一份空存档", before.body.data?.save, null);

    const pushed = await call(base, "PUT", "/api/game/save", { token: account.token, body: baseSave() });
    chk("首次推送 → 200", pushed.status, 200);
    chk("首次推送标记 firstPush", pushed.body.data?.firstPush, true);
    chk("泡泡存下来了", pushed.body.data?.save?.PlayerData?.bubbles, 100);
    chk("库存存下来了", pushed.body.data?.save?.PlayerData?.inventory?.fish?.fish001, 3);

    const after = await call(base, "GET", "/api/game/save", { token: account.token });
    chk("再读 → exists=true", after.body.data?.exists, true);
    chk("读回来的泡泡一致", after.body.data?.save?.PlayerData?.bubbles, 100);

    // 客户端试图改库存 → 服务端不认
    const cheat = baseSave();
    cheat.PlayerData = { ...baseSave().PlayerData, inventory: { fish: { fish001: 999 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } };
    const rejected = await call(base, "PUT", "/api/game/save", { token: account.token, body: cheat });
    chk("客户端改库存 → 服务端仍保持 3", rejected.body.data?.save?.PlayerData?.inventory?.fish?.fish001, 3);
    chkTrue("并且留下了「忽略了 inventory」的记录", (rejected.body.data?.adjustments || []).some(p => p.includes("inventory")));

    // 客户端改泡泡 → 接受（V1.0 泡泡是客户端权威，见 player-store.js 的说明）
    const grow = baseSave();
    grow.PlayerData = { ...baseSave().PlayerData, bubbles: 150 };
    const grown = await call(base, "PUT", "/api/game/save", { token: account.token, body: grow });
    chk("客户端改泡泡 → 接受", grown.body.data?.save?.PlayerData?.bubbles, 150);

    // 别人的令牌读不到你的存档
    const other = await newAccount(base);
    const otherSave = await call(base, "GET", "/api/game/save", { token: other.token });
    chkTrue("另一个账号看不到你的存档", otherSave.body.data?.exists === false);
    chkTrue("两个账号的 uid 不同", other.uid !== account.uid);
  } finally { server.kill(); }
}

console.log("\n--- 8. HTTP：购买走服务端，价格与库存以配置为准 ---");
{
  const { server, base } = await startServer({}, takePort());
  try {
    const account = await newAccount(base);
    await call(base, "PUT", "/api/game/save", { token: account.token, body: baseSave() });

    // decoration001（水草）price=20 maxInventory=1
    const bought = await call(base, "POST", "/api/game/shop/buy", { token: account.token, body: { itemId: "decoration001" } });
    chk("购买成功 → 200", bought.status, 200);
    chk("按服务端价格扣费", bought.body.data?.paid, 20);
    chk("余额 = 100 - 20", bought.body.data?.balance, 80);
    chk("库存 +1", bought.body.data?.save?.PlayerData?.inventory?.decorations?.decoration001, 1);

    const again = await call(base, "POST", "/api/game/shop/buy", { token: account.token, body: { itemId: "decoration001" } });
    chk("养满再买 → 400", again.status, 400);
    chk("错误码是 FULL", again.body.code, "FULL");

    // 🔴 价格防伪：接口只认 itemId，价格与数量一律取服务端配置。
    //    漏了这条，前端在请求体里塞个 price:1 就能一块钱买走背景。
    const spoofed = await call(base, "POST", "/api/game/shop/buy", {
      token: account.token,
      body: { itemId: "fish002", price: 1, quantity: -99, category: "fish" }
    });
    chk("客户端自报的价格被无视（按服务端 35 扣）", spoofed.body.data?.paid, 35);
    chk("余额 = 80 - 35", spoofed.body.data?.balance, 45);
    chk("客户端自报的 quantity 被无视（只 +1）", spoofed.body.data?.save?.PlayerData?.inventory?.fish?.fish002, 1);

    const missing = await call(base, "POST", "/api/game/shop/buy", { token: account.token, body: { itemId: "not-a-real-item" } });
    chk("买不存在的商品 → 404", missing.status, 404);

    const noId = await call(base, "POST", "/api/game/shop/buy", { token: account.token, body: {} });
    chk("不报 itemId → 400", noId.status, 400);

    // 会员商品：V1.0 不卖会员，所以买不到（上线前必须把后台的 isMemberOnly 全关掉）
    const memberOnly = await call(base, "POST", "/api/game/shop/buy", { token: account.token, body: { itemId: "fish003" } });
    chk("会员商品 → 403", memberOnly.status, 403);

    // 泡泡不够：fish002 price=35，余额 80，先把余额推低
    const poor = baseSave();
    poor.PlayerData = { ...baseSave().PlayerData, bubbles: 5 };
    await call(base, "PUT", "/api/game/save", { token: account.token, body: poor });
    const short = await call(base, "POST", "/api/game/shop/buy", { token: account.token, body: { itemId: "fish002" } });
    chk("泡泡不够 → 402（前端据此显示「还差 N」）", short.status, 402);
    chk("错误码是 INSUFFICIENT", short.body.code, "INSUFFICIENT");
    chk("给出还差多少", short.body.short, 30);
  } finally { server.kill(); }
}

console.log("\n--- 9. HTTP：专注记录与我的资料 ---");
{
  const { server, base } = await startServer({}, takePort());
  try {
    const account = await newAccount(base);
    await call(base, "PUT", "/api/game/save", { token: account.token, body: baseSave() });

    const me = await call(base, "GET", "/api/game/me", { token: account.token });
    chk("me 返回 uid", me.body.data?.userId, account.uid);
    chk("新账号 cohort 是 early（灰度期）", me.body.data?.cohort, "early");
    chk("me 带泡泡", me.body.data?.bubbles, 100);
    chk("me 带鱼数", me.body.data?.fishCount, 1);
    chk("新账号专注次数为 0", me.body.data?.focusCount, 0);

    // 带令牌专注 → 落库
    const started = await call(base, "POST", "/api/game/focus/start", { token: account.token, body: { plannedMinutes: 25 } });
    chk("开始专注 → 201", started.status, 201);
    chkTrue("拿到 sessionId", Boolean(started.body.data?.sessionId));

    const settled = await call(base, "POST", "/api/game/focus/complete", { token: account.token, body: { sessionId: started.body.data.sessionId } });
    chk("结算 → 200", settled.status, 200);

    const after = await call(base, "GET", "/api/game/me", { token: account.token });
    chk("专注记录进了服务端（次数 +1）", after.body.data?.focusCount, 1);

    // 同一个 sessionId 再结算一次 → 会话已被消费
    const replay = await call(base, "POST", "/api/game/focus/complete", { token: account.token, body: { sessionId: started.body.data.sessionId } });
    chk("重放同一个 sessionId → 404（奖励不能被重复领）", replay.status, 404);

    // 未登录也能专注：离线可玩是硬要求，登录不是前提
    const anonymous = await call(base, "POST", "/api/game/focus/start", { body: { plannedMinutes: 25 } });
    chk("不带令牌也能开始专注 → 201", anonymous.status, 201);
    chkTrue("未登录也拿到 sessionId", Boolean(anonymous.body.data?.sessionId));

    const anonymousMe = await call(base, "GET", "/api/game/me", { token: account.token });
    chk("未登录的那次不计入任何人的统计", anonymousMe.body.data?.focusCount, 1);
  } finally { server.kill(); }
}

console.log("\n--- 10. HTTP：没配会话密钥时明确 503，而不是静默放行 ---");
{
  // ADMIN_API_KEY 是派生会话密钥的来源。生产环境必然存在（否则进程直接退出），
  // 但本地裸跑时可能没有 —— 那种情况下存档接口必须明确拒绝，不能变成"谁都能写"。
  const { server, base } = await startServer({ ADMIN_API_KEY: "", FISHTANK_SESSION_SECRET: "" }, takePort());
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    chk("health.sessionKey 报 none", health.sessionKey, "none");
    // 注意：ADMIN_API_KEY 为空时管理接口也不鉴权，所以这里只验存档接口的行为。
    const res = await call(base, "POST", "/api/account/ticket", { body: {} });
    chkTrue("没有会话密钥时签发的令牌为空（前端会知道存档不可用）", !res.body.data?.token);
  } finally { server.kill(); }
}

console.log("\n--- 11. 批量结算：商店保存鱼缸（一次改完、原子落地） ---");
const ITEMS = new Map([
  ["fish001", { id: "fish001", name: "小丑鱼", category: "fish", price: 30, maxInventory: 50, isMemberOnly: false }],
  ["fish002", { id: "fish002", name: "蓝尾鱼", category: "fish", price: 35, maxInventory: 50, isMemberOnly: false }],
  ["fish003", { id: "fish003", name: "金色小鱼", category: "fish", price: 45, maxInventory: 50, isMemberOnly: true }],
  ["decoration001", { id: "decoration001", name: "水草", category: "decorations", price: 20, maxInventory: 1, isMemberOnly: false }],
  ["background001", { id: "background001", name: "浅海晨光", category: "backgrounds", price: 30, maxInventory: 1, isMemberOnly: false }],
  ["background002", { id: "background002", name: "深海夜色", category: "backgrounds", price: 60, maxInventory: 1, isMemberOnly: true }]
]);
const saveWith = ({ bubbles = 100, fish = { fish001: 3 }, aqua = {}, backgrounds = {} } = {}) => ({
  saveVersion: "0.2.0",
  PlayerData: {
    bubbles,
    isMember: false,
    inventory: { fish: { ...fish }, decorations: {}, backgrounds: { ...backgrounds }, sands: {}, sounds: {} }
  },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "", ...aqua },
  Settings: { audio: {} }
});
const fishEntries = (id, n) => Array.from({ length: n }, (_, i) => ({ itemId: id, instanceId: `${id}-${i}` }));

{
  const save = saveWith({ aqua: { fish: fishEntries("fish001", 1) } });
  const plan = planSettlement({ save, target: { fish: fishEntries("fish001", 3) }, items: ITEMS });
  chk("目标条数在库存内 → 不花钱（用现有库存）", plan.paid, 0);
  chk("库存不变", plan.save.PlayerData.inventory.fish.fish001, 3);
  chk("鱼缸摆上 3 条", plan.save.AquariumData.fish.length, 3);
}
{
  const save = saveWith({ fish: { fish001: 1 }, aqua: { fish: fishEntries("fish001", 1) } });
  const plan = planSettlement({ save, target: { fish: fishEntries("fish001", 3) }, items: ITEMS });
  chk("差 2 条 → 按服务端价买 2 条", plan.paid, 60);
  chk("库存补到 3", plan.save.PlayerData.inventory.fish.fish001, 3);
  chk("泡泡扣掉 60", plan.save.PlayerData.bubbles, 40);
}
{
  const save = saveWith({ aqua: { fish: fishEntries("fish001", 3) } });
  const plan = planSettlement({ save, target: { fish: fishEntries("fish001", 1) }, items: ITEMS });
  chk("撤下 2 条 → 退还 60", plan.refund, 60);
  chk("库存降到 1", plan.save.PlayerData.inventory.fish.fish001, 1);
  chk("泡泡增加 60", plan.save.PlayerData.bubbles, 160);
  chkTrue("收据里有「返还」行", plan.rows.some(r => r.name.includes("返还")), JSON.stringify(plan.rows));
}
{
  const plan = planSettlement({ save: saveWith(), target: { fish: [], background: "background001" }, items: ITEMS });
  chk("买下没拥有的背景 → 30", plan.paid, 30);
  chk("库存里有它了", plan.save.PlayerData.inventory.backgrounds.background001, 1);
  chk("鱼缸选中它", plan.save.AquariumData.background, "background001");
}
{
  const plan = planSettlement({
    save: saveWith({ backgrounds: { background001: 1 } }),
    target: { fish: [], background: "background001" },
    items: ITEMS
  });
  chk("已拥有的背景不再收费", plan.paid, 0);
}
{
  const save = saveWith({ aqua: { background: "background001" }, backgrounds: { background001: 1 } });
  const plan = planSettlement({ save, target: { fish: [], background: "" }, items: ITEMS });
  chk("撤下背景不退钱（否则能反复买卖套利）", plan.refund, 0);
  chk("撤下是真的撤下（不是被当成「没提交」而保留原值）", plan.save.AquariumData.background, "");
}
{
  const plan = planSettlement({ save: saveWith(), target: { fish: [], background: "background002" }, items: ITEMS });
  chk("会员商品 → PROBLEM", plan.code, "PROBLEM");
  chkTrue("说清是会员限定", String(plan.error).includes("会员限定"), plan.error);
}
{
  const plan = planSettlement({ save: saveWith({ bubbles: 10 }), target: { fish: fishEntries("fish002", 1) }, items: ITEMS });
  chk("余额不足 → INSUFFICIENT", plan.code, "INSUFFICIENT");
  chk("给出还差多少", plan.short, 25);
}
{
  // 退还当场抵扣：余额只剩 10，退 2 条鱼得 60，买 1 条鱼 35 → 够
  const save = saveWith({ bubbles: 10, aqua: { fish: fishEntries("fish001", 3) } });
  const plan = planSettlement({
    save,
    target: { fish: [...fishEntries("fish001", 1), ...fishEntries("fish002", 1)] },
    items: ITEMS
  });
  chk("退还先抵扣，余额够", plan.paid, 35);
  chk("退还记 60", plan.refund, 60);
  chk("净变化 = +60 - 35", plan.save.PlayerData.bubbles, 35);
}
{
  chk("没有存档 → NO_SAVE", planSettlement({ save: null, target: {}, items: ITEMS }).code, "NO_SAVE");
  chk("没有商品表 → NO_ITEMS", planSettlement({ save: saveWith(), target: {}, items: null }).code, "NO_ITEMS");
}
{
  // 拥有上限：maxInventory 是「最多养几条」，一次结算买超过上限要拦。
  // ⚠️ 单选槽位永远碰不到这条（已拥有就不会再买），所以必须用鱼来测。
  const LIMITED = new Map([
    ["fishX", { id: "fishX", name: "限量鱼", category: "fish", price: 10, maxInventory: 2, isMemberOnly: false }]
  ]);
  const plan = planSettlement({ save: saveWith({ bubbles: 1000, fish: {} }), target: { fish: fishEntries("fishX", 3) }, items: LIMITED });
  chk("一次买超上限 → PROBLEM", plan.code, "PROBLEM");
  chkTrue("说清是拥有上限", String(plan.error).includes("上限"), plan.error);
  const ok = planSettlement({ save: saveWith({ bubbles: 1000, fish: {} }), target: { fish: fishEntries("fishX", 2) }, items: LIMITED });
  chk("刚好买到上限 → 放行", ok.paid, 20);
}
{
  const { server, base } = await startServer({}, takePort());
  try {
    const noToken = await call(base, "POST", "/api/game/shop/settle", { body: { fish: [] } });
    chk("没令牌结算 → 401", noToken.status, 401);

    const account = await newAccount(base);
    await call(base, "PUT", "/api/game/save", { token: account.token, body: baseSave() });

    const first = await call(base, "POST", "/api/game/shop/settle", {
      token: account.token,
      body: { fish: [...fishEntries("fish001", 1), ...fishEntries("fish002", 1)], decoration: "", background: "background001", sand: "", ambientSound: "" }
    });
    chk("结算 → 200", first.status, 200);
    chk("新买 1 条 fish002 → 付 35", first.body.data?.paid, 35);
    chk("余额 100 - 35 = 65", first.body.data?.balance, 65);
    chk("库存里多了一条 fish002", first.body.data?.save?.PlayerData?.inventory?.fish?.fish002, 1);
    chk("鱼缸摆了 2 条", first.body.data?.save?.AquariumData?.fish?.length, 2);
    chkTrue("收据由服务端给出（前端不要用自己算的那份）",
      Array.isArray(first.body.data?.rows) && first.body.data.rows.length > 0, JSON.stringify(first.body.data?.rows));

    const refund = await call(base, "POST", "/api/game/shop/settle", {
      token: account.token,
      body: { fish: fishEntries("fish001", 1), decoration: "", background: "background001", sand: "", ambientSound: "" }
    });
    chk("撤下那条 fish002 → 退还 35", refund.body.data?.refund, 35);
    chk("余额回到 100", refund.body.data?.balance, 100);

    const memberOnly = await call(base, "POST", "/api/game/shop/settle", {
      token: account.token,
      body: { fish: [], decoration: "", background: "background002", sand: "", ambientSound: "" }
    });
    chk("会员商品 → 400", memberOnly.status, 400);

    const poorSave = baseSave();
    poorSave.PlayerData = { ...baseSave().PlayerData, bubbles: 5 };
    await call(base, "PUT", "/api/game/save", { token: account.token, body: poorSave });
    const poor = await call(base, "POST", "/api/game/shop/settle", {
      token: account.token,
      body: { fish: [...fishEntries("fish001", 1), ...fishEntries("fish002", 1)], decoration: "", background: "background001", sand: "", ambientSound: "" }
    });
    chk("余额不足 → 402", poor.status, 402);
    chk("错误码 INSUFFICIENT", poor.body.code, "INSUFFICIENT");
  } finally { server.kill(); }
}

console.log("\n----");
console.log(`cloud-save.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
