// 从备份恢复存档的回归测试。
//
// 这是**唯一能反向覆盖玩家存档**的功能，所以测试的重点不是「能不能写进去」，
// 而是三道安全闸：
//   ① 默认 dry-run —— 不传 mode:"apply" 就一个字都不写
//   ② 不做合并 —— 备份里就是完整存档，走 mergeSaveForWrite 会被截断泡泡/丢掉 inventory
//   ③ 回滚快照 —— apply 时把被覆盖的旧存档一并返回，恢复错了能反向恢复
// 外加 updated_at 必须写当前时间（写旧时间戳的话，玩家端会拿本地存档把它覆盖回去）。
//
// 运行：node test/save-restore.test.js
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, "..");

let pass = 0, fail = 0;
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

const NOW = new Date("2026-09-26T00:30:00").getTime();
const { createMemoryPlayerStore, createCloudbasePlayerStore } = await import("../player-store.js");

const saveWith = (bubbles, fishInTank = 1, ownedFish = 3) => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles, isMember: false, inventory: { fish: { fish001: ownedFish }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
  AquariumData: { fish: Array.from({ length: fishInTank }, (_, i) => ({ itemId: "fish001", instanceId: `f${i}` })), decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: { bgm: 38 } }
});

// ===== 1. 内存 store：dry-run / apply / create / unchanged / skipped =====
console.log("\n--- 1. 内存 store：三道安全闸 ---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  await store.putSave("u_1", saveWith(100, 1, 3));

  // ① dry-run
  const dry = await store.restoreSaves([{ userId: "u_1", data: saveWith(50, 3, 5) }], { dryRun: true });
  chk("dry-run 判定为 update", dry.items[0].action, "update");
  chk("dry-run 报告改动前泡泡", dry.items[0].before.bubbles, 100);
  chk("dry-run 报告改动后泡泡", dry.items[0].after.bubbles, 50);
  chk("dry-run 报告缸内鱼变化", [dry.items[0].before.fishInTank, dry.items[0].after.fishInTank], [1, 3]);
  chk("dry-run 不产生回滚快照", dry.rollback.length, 0);
  const untouched = await store.getSave("u_1");
  chk("🔴 ① dry-run 一个字都没写", untouched.data.PlayerData.bubbles, 100);

  // ② apply
  const applied = await store.restoreSaves([{ userId: "u_1", data: saveWith(50, 3, 5) }], { dryRun: false, at: NOW + 1000 });
  chk("apply 判定为 update", applied.items[0].action, "update");
  const written = await store.getSave("u_1");
  chk("apply 真的写进去了", written.data.PlayerData.bubbles, 50);
  chk("apply 写全了（缸内鱼）", written.data.AquariumData.fish.length, 3);
  chk("apply 写全了（拥有鱼）", written.data.PlayerData.inventory.fish.fish001, 5);
  chk("🔴 updated_at 用当前时间（不是备份里的时间）", written.updated_at, NOW + 1000);
  chk("🔴 ③ 回滚快照记下了被覆盖的旧存档", applied.rollback[0].data.PlayerData.bubbles, 100);
  chk("回滚快照带 userId", applied.rollback[0].userId, "u_1");

  // 用回滚快照反向恢复 —— 这是「恢复错了能救回来」的实际验证
  const reverted = await store.restoreSaves(applied.rollback, { dryRun: false, at: NOW + 2000 });
  chk("回滚快照能直接喂回 restoreSaves", reverted.items[0].action, "update");
  const back = await store.getSave("u_1");
  chk("🔴 用回滚快照恢复后泡泡回到 100", back.data.PlayerData.bubbles, 100);

  // create：库里没有这个用户
  const created = await store.restoreSaves([{ userId: "u_new", data: saveWith(200) }], { dryRun: false });
  chk("库里没有 → create", created.items[0].action, "create");
  chk("create 的 before 是 null", created.items[0].before, null);
  chk("🔴 create 不进回滚快照（没有旧值可回滚）", created.rollback.length, 0);
  const newSave = await store.getSave("u_new");
  chk("create 真的建出来了", newSave.data.PlayerData.bubbles, 200);

  // unchanged：内容一模一样 → 不改也不回滚（重复恢复是幂等的）
  const same = await store.restoreSaves([{ userId: "u_new", data: saveWith(200) }], { dryRun: false });
  chk("内容完全一致 → unchanged", same.items[0].action, "unchanged");
  chk("unchanged 不产生回滚快照", same.rollback.length, 0);

  // skipped：脏数据
  const bad = await store.restoreSaves([
    { userId: "", data: saveWith(1) },
    { userId: "u_x", data: "这不是对象" },
    { userId: "u_y", data: null }
  ], { dryRun: false });
  chk("缺 userId → skipped", bad.items[0].action, "skipped");
  chk("data 是字符串 → skipped", bad.items[1].action, "skipped");
  chk("data 是 null → skipped", bad.items[2].action, "skipped");
  chkTrue("skipped 带原因", bad.items.every(i => typeof i.reason === "string" && i.reason.length > 0));
  chk("脏数据没写进去", (await store.getSave("u_x")), null);
}

// ===== 2. 🔴 恢复必须绕开 mergeSaveForWrite =====
console.log("\n--- 2. 恢复不做合并（否则要恢复的东西又被改一遍）---");
{
  const store = createMemoryPlayerStore({ now: () => NOW });
  // 一份「客户端说了不算」的存档：超大泡泡 + 非默认 inventory + 会员标记
  const wild = {
    saveVersion: "0.2.0",
    PlayerData: { bubbles: 999999999, isMember: true, inventory: { fish: { fish999: 7 }, decorations: { decoration999: 2 }, backgrounds: {}, sands: {}, sounds: {} } },
    AquariumData: { fish: [{ itemId: "fish999", instanceId: "x1" }], decoration: "", background: "", sand: "", ambientSound: "" },
    Settings: {}
  };
  await store.restoreSaves([{ userId: "u_wild", data: wild }], { dryRun: false });
  const got = await store.getSave("u_wild");
  chk("🔴 泡泡不被 +2000 增量上限截断", got.data.PlayerData.bubbles, 999999999);
  chk("🔴 inventory 原样写入（不拿服务端现值覆盖）", got.data.PlayerData.inventory.fish.fish999, 7);
  chk("🔴 装扮库存原样写入", got.data.PlayerData.inventory.decorations.decoration999, 2);
  chk("🔴 缸内鱼原样写入（不被 normalizeAquarium 清掉）", got.data.AquariumData.fish[0].itemId, "fish999");
  chk("isMember 原样写入", got.data.PlayerData.isMember, true);

  // 反向对照：同一份内容走 mergeSaveForWrite（**已有存档**分支，也就是覆盖恢复的真实场景）
  // 会被改掉 —— 证明上面几条不是空闸。
  const { mergeSaveForWrite, MAX_BUBBLE_GAIN_PER_PUSH } = await import("../player-store.js");
  const storedSave = { saveVersion: "0.2.0", PlayerData: { bubbles: 100, isMember: false, inventory: { fish: { fish001: 3 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } }, AquariumData: { fish: [], decoration: "", background: "", sand: "", ambientSound: "" }, Settings: {} };
  const merged = mergeSaveForWrite(storedSave, wild);
  chk("R2 反向：走 merge 时泡泡被截到「服务端现值 + 单次上限」",
    merged.save.PlayerData.bubbles, 100 + MAX_BUBBLE_GAIN_PER_PUSH);
  chk("R2 反向：走 merge 时 inventory 用服务端现值，备份里的 fish999 被丢掉",
    merged.save.PlayerData.inventory.fish.fish999, undefined);
  chkTrue("R2 反向：走 merge 时缸内鱼被 normalizeAquarium 清掉（fish999 不在库存里）",
    merged.save.AquariumData.fish.length === 0);
}

// ===== 3. CloudBase 桩：查询面貌 + 脏 JSON =====
console.log("\n--- 3. CloudBase 桩 ---");
{
  const calls = [];
  const rows = new Map([
    ["u_1", { user_id: "u_1", data: JSON.stringify(saveWith(100)), save_version: "0.2.0", client_ts: 11, updated_at: 22 }]
  ]);
  const stubDb = {
    from(table) {
      const builder = {
        _op: null, _payload: null,
        select(cols) { calls.push({ table, op: "select", cols }); builder._op = "select"; return builder; },
        insert(rows2) { calls.push({ table, op: "insert" }); builder._op = "insert"; builder._payload = rows2[0]; return builder; },
        update(obj) { calls.push({ table, op: "update" }); builder._op = "update"; builder._payload = obj; return builder; },
        eq(col, val) { builder._eq = [col, val]; return builder; },
        // selectOne 会链一个 .limit(1)，桩得认（SDK 面貌的一部分）
        limit() { return builder; },
        throwOnError() {
          if (builder._op === "select") return { data: builder._eq ? (rows.has(builder._eq[1]) ? [rows.get(builder._eq[1])] : []) : [...rows.values()] };
          if (builder._op === "insert") { rows.set(builder._payload.user_id, builder._payload); return { data: [builder._payload] }; }
          if (builder._op === "update") { rows.set(builder._eq[1], { ...rows.get(builder._eq[1]), ...builder._payload }); return { data: [] }; }
          return { data: [] };
        }
      };
      return builder;
    }
  };
  const store = createCloudbasePlayerStore(stubDb, { now: () => NOW });

  const dry = await store.restoreSaves([{ userId: "u_1", data: saveWith(50) }], { dryRun: true });
  chk("CloudBase dry-run 判定 update", dry.items[0].action, "update");
  chk("CloudBase dry-run 前后泡泡", [dry.items[0].before.bubbles, dry.items[0].after.bubbles], [100, 50]);
  chkTrue("🔴 CloudBase dry-run 没发生任何写操作",
    !calls.some(c => c.op === "insert" || c.op === "update"), JSON.stringify(calls.map(c => c.op)));

  const before = calls.length;
  const applied = await store.restoreSaves([{ userId: "u_1", data: saveWith(50) }], { dryRun: false, at: NOW + 5000 });
  const writes = calls.slice(before);
  chk("CloudBase apply 发生了 update", writes.filter(c => c.op === "update").length, 1);
  chkTrue("写的是 saves 表", writes.filter(c => c.op === "update").every(c => c.table === "saves"));
  const stored = JSON.parse(rows.get("u_1").data);
  chk("CloudBase apply 真的写进去了", stored.PlayerData.bubbles, 50);
  chk("CloudBase apply 的 updated_at 是当前时间", rows.get("u_1").updated_at, NOW + 5000);
  chk("CloudBase 回滚快照记下旧值", JSON.parse(JSON.stringify(applied.rollback[0].data.PlayerData.bubbles)), 100);

  // 库里没有 → 走 insert
  const created = await store.restoreSaves([{ userId: "u_2", data: saveWith(7) }], { dryRun: false });
  chk("CloudBase 新建走 insert", calls.filter(c => c.op === "insert").length, 1);
  chk("CloudBase 新建判定 create", created.items[0].action, "create");
}

// ===== 4. HTTP 层 POST /api/admin/saves/restore =====
console.log("\n--- 4. HTTP：POST /api/admin/saves/restore ---");
let nextPort = 5500 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const CREDENTIALS_ENV = "CLOUDBASE_CUSTOM_LOGIN_KEY";
const credentials = { private_key_id: "self-test-key-id-restore", private_key: privateKey, env_id: "self-test-env-restore" };
const credentialsBase64 = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");
const ADMIN_KEY = "save-restore-test-key-0123456789";

const startServer = async (extraEnv, port) => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: ADMIN_KEY,
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
const call = async (base, method, urlPath, { token, adminKey, body } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (adminKey) headers["x-admin-key"] = adminKey;
  const res = await fetch(`${base}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const baseSave = () => ({
  saveVersion: "0.2.0",
  PlayerData: { bubbles: 100, isMember: false, inventory: { fish: { fish001: 3 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} } },
  AquariumData: { fish: [{ itemId: "fish001", instanceId: "f1" }], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: { bgm: 38 } }
});

{
  const { server, base } = await startServer({}, takePort());
  try {
    const noKey = await call(base, "POST", "/api/admin/saves/restore", { body: { saves: [] } });
    chk("无管理密钥 → 401", noKey.status, 401);

    const noSaves = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { mode: "dry-run" } });
    chk("缺 saves 数组 → 400", noSaves.status, 400);
    const emptySaves = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { saves: [] } });
    chk("空 saves → 400", emptySaves.status, 400);

    // 建号 + 推一份存档
    const ticket = await call(base, "POST", "/api/account/ticket", { body: {} });
    const token = ticket.body.data?.token;
    const uid = ticket.body.data?.uid;
    await call(base, "PUT", "/api/game/save", { token, body: baseSave() });

    const backupRow = { userId: uid, saveVersion: "0.2.0", clientTs: Date.now(), data: { ...baseSave(), PlayerData: { ...baseSave().PlayerData, bubbles: 777 } } };

    // ① 不传 mode → dry-run，不写
    const dry = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { saves: [backupRow] } });
    chk("不传 mode → dry-run", dry.body.data.mode, "dry-run");
    chk("dry-run applied=false", dry.body.data.applied, false);
    chk("dry-run counts.update = 1", dry.body.data.counts.update, 1);
    chk("dry-run 返回改动前后", [dry.body.data.items[0].before.bubbles, dry.body.data.items[0].after.bubbles], [100, 777]);
    chk("dry-run 不返回回滚快照", dry.body.data.rollback.length, 0);
    const stillOld = await call(base, "GET", "/api/game/save", { token });
    chk("🔴 dry-run 之后线上存档没变", stillOld.body.data.save.PlayerData.bubbles, 100);

    // ② mode:apply → 真写 + 回滚快照
    const applied = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { mode: "apply", saves: [backupRow] } });
    chk("apply mode 正确", applied.body.data.mode, "apply");
    chk("apply applied=true", applied.body.data.applied, true);
    chk("apply 返回回滚快照", applied.body.data.rollback.length, 1);
    chk("回滚快照里是被覆盖的旧存档（泡泡 100）", applied.body.data.rollback[0].data.PlayerData.bubbles, 100);
    const nowNew = await call(base, "GET", "/api/game/save", { token });
    chk("🔴 apply 之后线上存档真的变成 777", nowNew.body.data.save.PlayerData.bubbles, 777);
    chkTrue("updatedAt 比恢复前新（玩家端才会采用云端）", nowNew.body.data.updatedAt >= stillOld.body.data.updatedAt);

    // ③ 重复恢复 → unchanged（幂等）
    const again = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { mode: "apply", saves: [backupRow] } });
    chk("内容一致 → unchanged", again.body.data.counts.unchanged, 1);
    chk("unchanged 不产生回滚快照", again.body.data.rollback.length, 0);

    // ④ 用回滚快照反向恢复
    const revert = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { mode: "apply", saves: applied.body.data.rollback } });
    chk("回滚快照能直接喂回接口", revert.body.data.counts.update, 1);
    const reverted = await call(base, "GET", "/api/game/save", { token });
    chk("🔴 反向恢复后泡泡回到 100", reverted.body.data.save.PlayerData.bubbles, 100);

    // ⑤ 不存在的用户 → create，且被标进 missingUsers
    const ghost = { userId: "u_ghost_not_in_users", saveVersion: "0.2.0", clientTs: 0, data: baseSave() };
    const created = await call(base, "POST", "/api/admin/saves/restore", { adminKey: ADMIN_KEY, body: { mode: "apply", saves: [ghost] } });
    chk("库里没有该存档 → create", created.body.data.counts.create, 1);
    chkTrue("🔴 备份里有但 users 表没有的 uid 被标出来", created.body.data.missingUsers.includes("u_ghost_not_in_users"));
    chk("create 不产生回滚快照", created.body.data.rollback.length, 0);

    chkTrue("R4 反向：鉴权闸门存在（无密钥 401）", noKey.status === 401);
  } finally { server.kill(); }
}

console.log(`\n===== 存档恢复测试：${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exitCode = 1;
