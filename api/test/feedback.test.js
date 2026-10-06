// 玩家反馈（设置 → 关于 → 联系我们）的回归测试。
//
// 这个文件盯的是**这条链路的四件事**，不是「接口能返回 200」：
//   1) 输入归一化：空留言拒收、超长拒收、控制字符剥掉、联系方式压成一行。
//      —— 留言是玩家写的自由文本，也是唯一会被后台人工阅读的字段，
//      不归一化的话后台列表里会出现一堆换行与控制字符。
//   2) 身份：uid 只从令牌来。没有令牌 → 401；body 里塞 userId 一概不认
//      （否则就是个「以别人名义留言」的口子）。
//   3) 限流在身份解析**之前**：无效令牌也要占配额，否则拿假令牌就能刷爆写路径。
//   4) 🔴 注销必须把它一起删掉 —— contact 是玩家自己填的联系方式，属于个人信息。
//      「删除你的全部数据」这句话不成立的话，隐私政策就是空话。
//
// 全程自造 RSA 私钥 + 内存数据层 / CloudBase 桩，不连任何云环境。
// 运行：node test/feedback.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(here, "..");
const PORT = 4904;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = "feedback-test-key-0123456789";

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

const {
  normalizeFeedback, feedbackId, FEEDBACK_STATUSES,
  FEEDBACK_MESSAGE_MAX, FEEDBACK_CONTACT_MAX,
  createMemoryPlayerStore, createCloudbasePlayerStore
} = await import("../player-store.js");

// ===== 1. 输入归一化 =====
console.log("\n--- 1. 归一化：留言是自由文本，但不能是任意字节 ---");
chkTrue("空对象 → 拒", normalizeFeedback({}).ok === false);
chkTrue("只有空白的留言 → 拒", normalizeFeedback({ message: "   \n\t  " }).ok === false);
chkTrue("message 不是字符串 → 拒", normalizeFeedback({ message: 123 }).ok === false);
chk("正常一条 → 通过并 trim",
  normalizeFeedback({ contact: "  a@b.c  ", message: "  鱼不见了  " }),
  { ok: true, contact: "a@b.c", message: "鱼不见了" });
chk("联系方式可以为空（不强制留）",
  normalizeFeedback({ message: "随便说说" }),
  { ok: true, contact: "", message: "随便说说" });
chkTrue("留言超长 → 拒", normalizeFeedback({ message: "字".repeat(FEEDBACK_MESSAGE_MAX + 1) }).ok === false);
chkTrue("联系方式超长 → 拒", normalizeFeedback({ contact: "x".repeat(FEEDBACK_CONTACT_MAX + 1), message: "hi" }).ok === false);
chk("恰好到上限 → 放行（边界是「超过」才拒）",
  normalizeFeedback({ message: "字".repeat(FEEDBACK_MESSAGE_MAX) }).ok, true);

console.log("\n--- 1b. 控制字符与换行 ---");
{
  const out = normalizeFeedback({ message: "第一行\n第二行" });
  chk("多行留言保留换行（玩家排版的一部分）", out.message, "第一行\n第二行");
  const nul = normalizeFeedback({ message: "abc\u0000def\u0007ghi" });
  chk("NUL / BEL 这类控制字符被剥掉", nul.message, "abcdefghi");
  const contactMultiline = normalizeFeedback({ contact: "a@b.c\n\nd@e.f", message: "hi" });
  chk("联系方式里的换行被压成空格（否则后台表格排版会崩）", contactMultiline.contact, "a@b.c d@e.f");
  const many = normalizeFeedback({ message: "a" + "\n".repeat(10) + "b" });
  chkTrue("连续空行被收敛（不留一大段空白）", many.message.length < 10, JSON.stringify(many.message));
}

console.log("\n--- 1c. 状态白名单与 id ---");
chk("状态枚举固定三档", FEEDBACK_STATUSES, ["new", "read", "done"]);
{
  const a = feedbackId(), b = feedbackId();
  chkTrue("id 带 fb_ 前缀", a.startsWith("fb_"));
  chkTrue("两次生成不撞（同毫秒也不会）", a !== b, `${a} / ${b}`);
  chkTrue("长度不超过列宽 36", a.length <= 36, String(a.length));
}

// ===== 2. 内存实现 =====
console.log("\n--- 2. 内存实现：落库 / 列表 / 标记 / 删除 ---");
const NOW = 1_760_000_000_000;
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  const row = await store.addFeedback({
    id: "fb_1", userId: "u_a", nickname: "小鱼", contact: "a@b.c", message: "第一条", at: NOW - 1000
  });
  chk("新留言默认 status=new", row.status, "new");
  chk("新留言 handled_at=0", row.handled_at, 0);
  chk("_sizes 暴露 feedback 条数", store._sizes().feedback, 1);

  await store.addFeedback({ id: "fb_2", userId: "u_b", nickname: "大鱼", contact: "", message: "第二条", at: NOW });
  const all = await store.listFeedback({});
  chk("按创建时间倒序（新的在前）", all.map(f => f.id), ["fb_2", "fb_1"]);

  const filtered = await store.listFeedback({ status: "new" });
  chk("按状态过滤", filtered.length, 2);
  chk("过滤一个没有的状态 → 空", (await store.listFeedback({ status: "done" })).length, 0);
  chk("limit 生效", (await store.listFeedback({ limit: 1 })).map(f => f.id), ["fb_2"]);

  const marked = await store.setFeedbackStatus("fb_1", "done", { at: NOW + 5000 });
  chk("标记后状态变了", marked.status, "done");
  chk("标记后写了处理时间", marked.handled_at, NOW + 5000);
  const back = await store.setFeedbackStatus("fb_1", "new", { at: NOW + 9000 });
  chk("🔴 退回 new 时清掉处理时间（否则列表里会出现「未处理但带处理时间」）", back.handled_at, 0);
  chk("标记不存在的 id → null", await store.setFeedbackStatus("fb_不存在", "read"), null);

  chk("删除 1 条", await store.deleteFeedback(["fb_1"]), 1);
  chk("再删同一条 → 0（幂等）", await store.deleteFeedback(["fb_1"]), 0);
  chk("剩下那条没被误伤", (await store.listFeedback({})).map(f => f.id), ["fb_2"]);
  chk("传非数组也不炸", await store.deleteFeedback(undefined), 0);
}

// ===== 3. CloudBase 桩 =====
console.log("\n--- 3. CloudBase 桩：查询面貌与「不回传行数」的兜底 ---");
{
  const state = { feedback: [] };
  const calls = [];
  const stubDb = {
    from(table) {
      let op = null;
      let payload = null;
      const filters = [];
      const builder = {
        select(cols) { op = "select"; calls.push({ table, op, cols }); return builder; },
        insert(rows) { op = "insert"; payload = rows; calls.push({ table, op, rows }); return builder; },
        update(patch) { op = "update"; payload = patch; calls.push({ table, op, patch }); return builder; },
        delete() { op = "delete"; calls.push({ table, op }); return builder; },
        eq(col, value) { filters.push([col, value]); return builder; },
        limit() { return builder; },
        throwOnError() {
          const hit = row => filters.every(([col, value]) => String(row[col]) === String(value));
          if (op === "insert") { state[table].push(...payload.map(r => ({ ...r }))); return { data: null }; }
          if (op === "delete") { state[table] = state[table].filter(row => !hit(row)); return { data: null }; }
          if (op === "update") {
            for (const row of state[table]) if (hit(row)) Object.assign(row, payload);
            return { data: null };
          }
          return { data: state[table].filter(hit).map(row => ({ ...row })) };
        }
      };
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stubDb, { now: () => NOW });

  const row = await store.addFeedback({ id: "fb_c1", userId: "u_1", nickname: "甲", contact: "a@b.c", message: "云版", at: NOW });
  chk("云版写入后返回的 status 是 new", row.status, "new");
  chk("真的写进表了", state.feedback.length, 1);
  chkTrue("insert 用的是 insert([...]) 形态", calls.some(c => c.op === "insert" && Array.isArray(c.rows)));

  const listed = await store.listFeedback({});
  chk("列表能读回来", listed.map(f => f.id), ["fb_c1"]);
  chkTrue("列表用的是 select(\"*\")（列裁剪交给 JS）", calls.filter(c => c.op === "select").every(c => c.cols === "*"));

  const marked = await store.setFeedbackStatus("fb_c1", "done", { at: NOW + 1 });
  chk("标记后回读的是真实落库值", [marked.status, Number(marked.handled_at)], ["done", NOW + 1]);
  chk("标记不存在的 id → null（先查后写，不靠影响行数）", await store.setFeedbackStatus("fb_没有", "read"), null);

  chk("删除 1 条", await store.deleteFeedback(["fb_c1"]), 1);
  chk("再删同一条 → 0", await store.deleteFeedback(["fb_c1"]), 0);
  chk("表里确实空了", state.feedback.length, 0);
}

// ===== 4. 起服务：HTTP 层 =====
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDS = Buffer.from(JSON.stringify({
  private_key_id: "feedback-key-id-0001", private_key: privateKey, env_id: "feedback-env-0001"
}), "utf8").toString("base64");

const server = spawn(process.execPath, ["server.js"], {
  cwd: API_DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    EXTRA_PORTS: "0",
    NODE_ENV: "test",
    ADMIN_API_KEY: ADMIN_KEY,
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
  if (opts.adminKey) h["x-admin-key"] = opts.adminKey;
  const r = await fetch(BASE + p, {
    method, headers: h,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const newAccount = async () => {
  const r = await call("POST", "/api/account/ticket", { body: {} });
  if (!r.body || !r.body.data) throw new Error(`建号失败：${r.status} ${JSON.stringify(r.body)}`);
  return { uid: r.body.data.uid, token: r.body.data.token };
};
const SAVE = bubbles => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: {} } },
  AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});

try {
  console.log("\n--- 4. 提交接口的门禁 ---");
  chk("无令牌 → 401", (await call("POST", "/api/feedback", { body: { message: "hi" } })).status, 401);
  chk("坏令牌 → 401", (await call("POST", "/api/feedback", { token: "not-a-real-token", body: { message: "hi" } })).status, 401);

  const alice = await newAccount();
  await call("PUT", "/api/game/save", { token: alice.token, body: SAVE(10) });
  // 昵称走正常的档案接口写进去，用来验证「服务端读档案、不采信客户端提交的昵称」。
  await call("PUT", "/api/game/me", { token: alice.token, body: { nickname: "小海豚" } });

  chk("缺留言内容 → 400", (await call("POST", "/api/feedback", { token: alice.token, body: {} })).status, 400);
  chk("只有空白留言 → 400", (await call("POST", "/api/feedback", { token: alice.token, body: { message: "   " } })).status, 400);
  chk("留言超长 → 400",
    (await call("POST", "/api/feedback", { token: alice.token, body: { message: "字".repeat(FEEDBACK_MESSAGE_MAX + 1) } })).status, 400);

  console.log("\n--- 5. 提交成功：昵称取服务端档案 ---");
  const submitted = await call("POST", "/api/feedback", {
    token: alice.token,
    // 故意在 body 里塞一个假昵称和一个假 uid —— 两者都必须被忽略。
    body: { nickname: "我是管理员", userId: "u_别人的号", contact: "alice@example.com", message: "鱼缸里的水草挡到鱼了" }
  });
  chk("提交 → 201", submitted.status, 201);
  chkTrue("返回了 id", typeof submitted.body.data.id === "string" && submitted.body.data.id.startsWith("fb_"));
  chkTrue("返回了创建时间", Number(submitted.body.data.createdAt) > 0);

  const listAll = await call("GET", "/api/admin/feedback", { adminKey: ADMIN_KEY });
  chk("后台能看到这条", listAll.body.data.count, 1);
  const item = listAll.body.data.feedback[0];
  chk("🔴 userId 是令牌里的 uid（body 里塞的假 uid 被忽略）", item.userId, alice.uid);
  chk("🔴 nickname 取自服务端档案（body 里塞的假昵称被忽略）", item.nickname, "小海豚");
  chk("联系方式存下来了", item.contact, "alice@example.com");
  chk("正文存下来了", item.message, "鱼缸里的水草挡到鱼了");
  chk("默认状态 new", item.status, "new");
  chk("状态枚举也下发给后台（前端不抄一遍）", listAll.body.data.statuses, FEEDBACK_STATUSES);

  console.log("\n--- 6. 后台：列表过滤 / 标记 / 删除 ---");
  chk("无管理密钥 → 401", (await call("GET", "/api/admin/feedback")).status, 401);
  chk("非法 status → 400", (await call("GET", "/api/admin/feedback?status=乱写", { adminKey: ADMIN_KEY })).status, 400);
  chk("按 new 过滤能查到", (await call("GET", "/api/admin/feedback?status=new", { adminKey: ADMIN_KEY })).body.data.count, 1);
  chk("按 done 过滤为空", (await call("GET", "/api/admin/feedback?status=done", { adminKey: ADMIN_KEY })).body.data.count, 0);

  const badStatus = await call("PUT", `/api/admin/feedback/${item.id}`, { adminKey: ADMIN_KEY, body: { status: "已处理" } });
  chk("标记成非法状态 → 400", badStatus.status, 400);
  const marked = await call("PUT", `/api/admin/feedback/${item.id}`, { adminKey: ADMIN_KEY, body: { status: "done" } });
  chk("标记 done → 200", marked.status, 200);
  chk("返回的就是落库后的值", marked.body.data.feedback.status, "done");
  chkTrue("带上了处理时间", Number(marked.body.data.feedback.handledAt) > 0);
  chk("标记不存在的 id → 404", (await call("PUT", "/api/admin/feedback/fb_没有这条", { adminKey: ADMIN_KEY, body: { status: "done" } })).status, 404);
  chk("🔴 后台没有「改留言内容」的入口：PUT 只认 status",
    (await call("GET", "/api/admin/feedback", { adminKey: ADMIN_KEY })).body.data.feedback[0].message, "鱼缸里的水草挡到鱼了");

  console.log("\n--- 7. 🔴 停机中仍然能提交（与注销同理：维护时最需要反馈）---");
  const bob = await newAccount();
  await call("PUT", "/api/game/save", { token: bob.token, body: SAVE(20) });
  await call("PUT", "/api/admin/ops/ops", {
    adminKey: ADMIN_KEY,
    body: { maintenance: true, maintenanceMessage: "测试停机", maintenanceEta: "", maintenanceAllowUids: [] }
  });
  await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });

  chk("停机中：普通写接口 → 503", (await call("PUT", "/api/game/save", { token: bob.token, body: SAVE(999) })).status, 503);
  const during = await call("POST", "/api/feedback", { token: bob.token, body: { message: "维护期间进不去" } });
  chk("🔴 停机中：提交反馈仍然放行 → 201", during.status, 201);

  await call("PUT", "/api/admin/ops/ops", {
    adminKey: ADMIN_KEY,
    body: { maintenance: false, maintenanceMessage: "", maintenanceEta: "", maintenanceAllowUids: [] }
  });
  await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });

  console.log("\n--- 8. 删除与路由注册顺序 ---");
  const removed = await call("DELETE", `/api/admin/feedback/${item.id}`, { adminKey: ADMIN_KEY });
  chk("删除 → 200", removed.status, 200);
  chk("报删掉 1 条", removed.body.data.deleted, 1);
  chk("删不存在的 id → 404（后台是人在点，别静默无事发生）",
    (await call("DELETE", "/api/admin/feedback/fb_没有这条", { adminKey: ADMIN_KEY })).status, 404);
  chk("删完只剩 B 的那条", (await call("GET", "/api/admin/feedback", { adminKey: ADMIN_KEY })).body.data.feedback.map(f => f.userId), [bob.uid]);

  // 后台反馈路由必须注册在通配路由之前，否则 POST/PUT/DELETE 会被截走。
  {
    const fs = await import("node:fs");
    const source = fs.readFileSync(path.join(API_DIR, "server.js"), "utf8");
    const lines = source.split(/\r?\n/);
    const lineOf = needle => {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (t.startsWith(needle)) return i + 1;
      }
      return -1;
    };
    const getFb = lineOf('app.get("/api/admin/feedback"');
    const putFb = lineOf('app.put("/api/admin/feedback/:id"');
    const delFb = lineOf('app.delete("/api/admin/feedback/:id"');
    const wildcardPost = lineOf('app.post("/api/admin/:type"');
    const wildcardDel = lineOf('app.delete("/api/admin/:type/:id"');
    chkTrue("三条后台反馈路由都注册了", getFb > 0 && putFb > 0 && delFb > 0);
    chkTrue("PUT 在 app.delete(\"/api/admin/:type/:id\") 之前", putFb > 0 && wildcardDel > 0 && putFb < wildcardDel);
    chkTrue("DELETE 在 app.delete(\"/api/admin/:type/:id\") 之前", delFb > 0 && wildcardDel > 0 && delFb < wildcardDel);
    chkTrue("后台反馈路由整体在 app.post(\"/api/admin/:type\") 之前",
      Math.max(getFb, putFb, delFb) < wildcardPost);
    // 玩家端路由不带 /api/admin 前缀 → 不会被管理鉴权拦掉
    const playerPost = lineOf('app.post("/api/feedback"');
    chkTrue("玩家端 POST /api/feedback 已注册", playerPost > 0);
    chkTrue("玩家端路径不带 /api/admin 前缀（不会被管理鉴权拦）", !"/api/feedback".startsWith("/api/admin"));
  }
} catch (error) {
  console.log(`\n运行出错：${error && error.stack ? error.stack : error}`);
  console.log("服务日志：\n" + logs);
  fail++;
} finally {
  server.kill();
}

console.log(`\n===== 玩家反馈测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
