// 运营配置（停机 + 通知）：ops 作为单例配置类型接入通用 fishtank_configs 仓库。
//
// 锁的五件事：
//   1) 内存仓库：seed 自带 ops 单例；save 进草稿，publish 写回 publishedData。
//   2) 🔴 seed 迁移不冲掉停机状态 —— 停机开关、白名单、通知文案必须跨重启保留。
//   3) 停机闸门（ops-guard）：维护中拦写、白名单 uid 豁免、配置读不到时失败开放。
//   4) HTTP：无管理密钥 → 401；草稿不生效；发布后玩家端可见。
//   5) HTTP 闸门：发布 maintenance=true → 写接口 503；未发布（草稿）不拦。
//
// 运行：node api/test/ops-config.test.js   （或归入 run-unit.mjs 从仓库根跑）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  createMemoryRepository, planSeedMigration, applySeedDefault,
  createCloudbaseRepository, setRdbForTest
} from "../repository.js";
import { isMaintenanceBlocked } from "../ops-guard.js";

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

const OPS_SEED_SHAPE = {
  maintenance: false,
  maintenanceMessage: "",
  maintenanceEta: "",
  maintenanceAllowUids: [],
  notice: { id: "", level: "info", title: "", body: "", startAt: 0, endAt: 0, ctaText: "", ctaUrl: "", active: false }
};

const OPS_ON = {
  maintenance: true,
  maintenanceMessage: "正在维护，预计 22:10 恢复",
  maintenanceEta: "22:10",
  maintenanceAllowUids: ["u_self_0001"],
  notice: { id: "2026-09-30-m1", level: "warning", title: "今晚维护", body: "鱼和泡泡都不会丢。", startAt: 1790323200000, endAt: 1790359200000, ctaText: "", ctaUrl: "", active: true }
};

console.log("--- 1. 内存仓库：seed / save(草稿) / publish ---");
{
  const repo = createMemoryRepository();
  const seedList = await repo.list("ops", false);
  chk("seed 自带 ops 单例", seedList.length, 1);
  chk("ops id 为 ops", seedList[0]?.id, "ops");
  chk("seed 默认未停机", seedList[0]?.data?.maintenance, false);
  chk("seed 默认已发布", seedList[0]?.published, true);
  chk("notice 字段齐全", Object.keys(seedList[0]?.data?.notice || {}).sort(),
    ["active","body","ctaText","ctaUrl","endAt","id","level","startAt","title"]);

  const saved = await repo.save("ops", "ops", OPS_ON);
  chk("save 后 published=false（进草稿）", saved.published, false);
  chk("save 写入 data", saved.data.maintenance, true);

  saved.data.maintenance = false;
  const again = await repo.list("ops", false);
  chk("深拷贝：store 内部未被返回值污染", again[0].data.maintenance, true);

  const published = await repo.publish("ops", "ops");
  chk("publish 后 published=true", published.published, true);
  chk("publish 写回 publishedData", published.publishedData.maintenanceEta, "22:10");
}

console.log("\n--- 2. 🔴 seed 迁移不能冲掉停机状态 ---");
{
  const plan = planSeedMigration("ops", [OPS_SEED_SHAPE], []);
  chk("空库时 ops 计划为 insert", plan[0].action, "insert");
  chk("ops 单例 id 为 ops", plan[0].id, "ops");

  // 后台已经开了停机、填了白名单和通知 —— 这些不能因为重启/部署被 seed 冲掉。
  const stored = {
    maintenance: true,
    maintenanceMessage: "正在维护",
    maintenanceAllowUids: ["u_self_0001"],
    notice: { id: "2026-09-30-m1", level: "warning", title: "今晚维护", body: "鱼和泡泡都不会丢。", startAt: 1790323200000, endAt: 1790359200000, ctaText: "", ctaUrl: "", active: true }
  };
  const out = applySeedDefault("ops", stored, OPS_SEED_SHAPE);
  chk("停机状态不被 seed 冲掉", out.maintenance, true);
  chk("维护文案保留", out.maintenanceMessage, "正在维护");
  chk("白名单 uid 保留", out.maintenanceAllowUids, ["u_self_0001"]);
  chk("seed 新增字段会补齐（maintenanceEta）", out.maintenanceEta, "");
  chk("notice 保留后台填的内容", out.notice.title, "今晚维护");
  chk("notice 缺的字段由 seed 补齐", out.notice.ctaText, "");

  // 反向：普通单例（focus）仍是「以 seed 为准」，这个行为没被改坏。
  const focusOut = applySeedDefault("focus", { minFocusDuration: 25 }, { minFocusDuration: 30 });
  chk("普通单例仍以 seed 为准（未改坏既有行为）", focusOut.minFocusDuration, 30);

  // 空 stored（首次写入）→ 用 seed
  chk("stored 为空时直接用 seed", applySeedDefault("ops", {}, OPS_SEED_SHAPE).maintenance, false);
}

console.log("\n--- 3. 停机闸门（纯函数） ---");
{
  chk("未停机 → 不拦", isMaintenanceBlocked({ ...OPS_SEED_SHAPE }, "u_1"), false);
  chk("停机 + 普通 uid → 拦", isMaintenanceBlocked({ ...OPS_SEED_SHAPE, maintenance: true }, "u_1"), true);
  chk("停机 + 白名单 uid → 放行", isMaintenanceBlocked(OPS_ON, "u_self_0001"), false);
  chk("停机 + 未登录（空 uid）→ 拦", isMaintenanceBlocked({ ...OPS_SEED_SHAPE, maintenance: true }, ""), true);
  chk("配置读不到 → 失败开放（不拦）", isMaintenanceBlocked(null, "u_1"), false);
  chk("maintenance 不是严格 true → 不拦", isMaintenanceBlocked({ maintenance: "true" }, "u_1"), false);
  chk("白名单不是数组 → 不误放行", isMaintenanceBlocked({ maintenance: true, maintenanceAllowUids: "u_1" }, "u_1"), true);
}

console.log("\n--- 4. 云端仓库（桩）：select('*') 面貌 / 映射 / save / publish ---");
{
  function makeFakeRdb() {
    const rows = [];
    const flags = { selectStar: false, order: false };
    const from = () => {
      const eqs = {};
      const chain = {
        select(cols) { if (cols === "*") flags.selectStar = true; return chain; },
        order() { flags.order = true; return chain; },
        eq(col, val) { eqs[col] = val; return chain; },
        limit() { return chain; },
        insert(payload) { chain._op = { kind: "insert", payload }; return chain; },
        update(obj) { chain._op = { kind: "update", obj }; return chain; },
        delete() { chain._op = { kind: "delete" }; return chain; },
        async throwOnError() {
          if (chain._op && chain._op.kind === "insert") {
            for (const p of chain._op.payload) rows.push({ id: String(rows.length + 1), ...p });
            return { data: chain._op.payload };
          }
          if (chain._op && chain._op.kind === "update") {
            const i = rows.findIndex(r => r.id === eqs.id);
            if (i >= 0) rows[i] = { ...rows[i], ...chain._op.obj };
            return { data: [rows[i]] };
          }
          if (chain._op && chain._op.kind === "delete") {
            const i = rows.findIndex(r => r.id === eqs.id);
            if (i >= 0) rows.splice(i, 1);
            return { data: [] };
          }
          let data = rows;
          if (eqs.type !== undefined) data = data.filter(r => r.type === eqs.type);
          if (eqs.config_id !== undefined) data = data.filter(r => r.config_id === eqs.config_id);
          if (eqs.id !== undefined) data = data.filter(r => r.id === eqs.id);
          if (eqs.published !== undefined) data = data.filter(r => r.published === eqs.published);
          return { data: data.map(r => ({ ...r })) };
        }
      };
      return chain;
    };
    return { from, flags, rows };
  }
  const fake = makeFakeRdb();
  setRdbForTest(fake);
  const repo = await createCloudbaseRepository();
  chkTrue("云端查询走 select('*')", fake.flags.selectStar === true);
  chkTrue("云端绝不调用 .order()", fake.flags.order === false);

  const list = await repo.list("ops", true);
  chk("云端 seed ops 已发布且可读", list.length === 1 && list[0].id === "ops", true);

  const saved = await repo.save("ops", "ops", OPS_ON);
  chk("云端 save 进草稿", saved.published, false);
  chk("草稿未发布 → 玩家端拉不到", (await repo.list("ops", true)).length, 0);

  const published = await repo.publish("ops", "ops");
  chk("云端 publish 写回 publishedData", published.publishedData.maintenance, true);

  setRdbForTest(null);
}

console.log("\n--- 5. HTTP：鉴权闸门 + 草稿/发布生命周期 + 停机拦截 ---");
{
  const ADMIN_KEY = "ops-config-test-key-0123456789";
  const PORT = 4733;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      EXTRA_PORTS: "0",
      NODE_ENV: "test",
      ADMIN_API_KEY: ADMIN_KEY,
      CLOUDBASE_ENV_ID: ""
    }
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    const call = async (method, urlPath, { adminKey, body } = {}) => {
      const headers = { "content-type": "application/json" };
      if (adminKey) headers["x-admin-key"] = adminKey;
      const res = await fetch(`${base}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };

    const noKey = await call("PUT", "/api/admin/ops/ops", { body: OPS_ON });
    chk("反向：无管理密钥 → 401（闸门在）", noKey.status, 401);

    const before = await call("GET", "/api/game/ops");
    chk("玩家端默认可读 seed ops", (before.json.data || []).length >= 1, true);

    const saved = await call("PUT", "/api/admin/ops/ops", { adminKey: ADMIN_KEY, body: OPS_ON });
    chk("带密钥 PUT → 200", saved.status, 200);
    chk("保存后为草稿（published=false）", saved.json.data?.published, false);

    // 🔴 草稿阶段的停机不该生效 —— 后台「保存」≠ 生效，这条是防误伤的关键。
    const draftStart = await call("POST", "/api/game/focus/start", { body: {} });
    chk("反向：草稿未发布 → 停机不生效（不是 503）", draftStart.status !== 503, true);

    const published = await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });
    chk("发布 → 200", published.status, 200);

    const after = await call("GET", "/api/game/ops");
    const rec = (after.json.data || []).find(r => r.id === "ops");
    chk("发布后玩家端可见", !!rec, true);
    chk("玩家端拿到已发布的停机状态", rec?.data?.maintenance, true);

    // 停机发布后：写接口被拦，读接口照常。
    const blocked = await call("POST", "/api/game/focus/start", { body: {} });
    chk("停机中 → 写接口 503", blocked.status, 503);
    chk("503 响应带 maintenance 标记（前端据此切维护页）", blocked.json.maintenance, true);
    chk("503 响应带维护文案", blocked.json.error, "正在维护，预计 22:10 恢复");

    const readOk = await call("GET", "/api/game/ops");
    chk("停机中读接口照常（玩家还看得到自己的鱼）", readOk.status, 200);

    // 关停机并发布 → 写接口恢复
    await call("PUT", "/api/admin/ops/ops", { adminKey: ADMIN_KEY, body: { ...OPS_SEED_SHAPE } });
    await call("POST", "/api/admin/ops/ops/publish", { adminKey: ADMIN_KEY });
    const unblocked = await call("POST", "/api/game/focus/start", { body: {} });
    chk("关停机并发布 → 写接口不再是 503", unblocked.status !== 503, true);
  } finally {
    server.kill();
  }
}

console.log(`\n==== ops-config: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
