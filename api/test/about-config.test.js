// 「关于」区块内容后台可配置：about 作为单例配置类型接入通用 fishtank_configs 仓库。
//
// 锁的四件事：
//   1) 内存仓库：seed 自带 about 单例；save 把 published 置 false（草稿），publish 写回 publishedData。
//   2) 云端仓库：查询只走 select("*")、绝不碰 .order()；snake→camel 映射正确；save/publish 行为一致。
//   3) HTTP：无管理密钥 → 401；带密钥才能 PUT /api/admin/about/about；发布前草稿对玩家不可见，发布后才可见。
//   4) 反向：把保护拿掉（无密钥也能写 / 草稿直接可见）应让断言变红。
//
// 运行：node api/test/about-config.test.js   （或归入 run-unit.mjs 从仓库根跑）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createMemoryRepository, planSeedMigration, createCloudbaseRepository, setRdbForTest } from "../repository.js";

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

const NEW_ABOUT = {
  terms:  { title: "用户协议", bodyHtml: "<p>新版协议。</p>" },
  privacy:{ title: "隐私政策", bodyHtml: "<p>新版隐私。</p>" },
  story:  { title: "品牌故事", bodyHtml: "<p>新版故事。</p>" },
  tip:    { title: "打赏支持", bodyHtml: "<p>谢谢支持。</p>", imageUrl: "https://example.com/qr.png" },
  filing: { title: "备案信息", bodyHtml: "<p>沪ICP备000000号。</p>" }
};

console.log("--- 1. 内存仓库：seed / save(草稿) / publish ---");
{
  const repo = createMemoryRepository();
  const seedList = await repo.list("about", false);
  chk("seed 自带 about 单例", seedList.length, 1);
  chk("about id 为 about", seedList[0]?.id, "about");
  chk("含 5 个 section", Object.keys(seedList[0]?.data || {}).sort(), ["filing","privacy","story","terms","tip"]);
  chk("seed 默认已发布", seedList[0]?.published, true);

  const saved = await repo.save("about", "about", NEW_ABOUT);
  chk("save 后 published=false（进草稿）", saved.published, false);
  chk("save 写入 data", saved.data.terms.title, "用户协议");

  // 深拷贝：改返回值不能动到 store 内部
  saved.data.terms.title = "被外部改了";
  const again = await repo.list("about", false);
  chk("深拷贝：store 内部未被返回值污染", again[0].data.terms.title, "用户协议");

  const published = await repo.publish("about", "about");
  chk("publish 后 published=true", published.published, true);
  chk("publish 写回 publishedData", published.publishedData.terms.title, "用户协议");
}

console.log("\n--- 2. 云端规划纯函数：about 走单例 id 映射 ---");
{
  const aboutSeed = {
    terms:  { title: "用户协议", bodyHtml: "<p>占位</p>" },
    privacy:{ title: "隐私政策", bodyHtml: "<p>占位</p>" },
    story:  { title: "品牌故事", bodyHtml: "<p>占位</p>" },
    tip:    { title: "打赏支持", bodyHtml: "<p>占位</p>", imageUrl: "" },
    filing: { title: "备案信息", bodyHtml: "<p>占位</p>" }
  };
  const plan = planSeedMigration("about", [aboutSeed], []);
  chk("空库时 about 计划为 insert", plan[0].action, "insert");
  chk("about 单例 id 为 about", plan[0].id, "about");
}

console.log("\n--- 3. 云端仓库（桩）：select('*') 面貌 / 映射 / save / publish ---");
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

  const list = await repo.list("about", true);
  chk("云端 seed about 已发布且可读", list.length === 1 && list[0].id === "about", true);
  chk("云端 snake→camel：publishedData 映射到位", !!list[0].publishedData, true);

  const saved = await repo.save("about", "about", NEW_ABOUT);
  chk("云端 save 进草稿", saved.published, false);
  const afterSave = await repo.list("about", true);
  chk("草稿未发布 → 玩家端拉不到", afterSave.length, 0);

  const published = await repo.publish("about", "about");
  chk("云端 publish 写回 publishedData", published.publishedData.tip.imageUrl, "https://example.com/qr.png");

  setRdbForTest(null);
}

console.log("\n--- 4. HTTP：鉴权闸门 + 草稿/发布生命周期 ---");
{
  const ADMIN_KEY = "about-config-test-key-0123456789";
  const PORT = 4731;
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

    const noKey = await call("PUT", "/api/admin/about/about", { body: NEW_ABOUT });
    chk("反向：无管理密钥 → 401（闸门在）", noKey.status, 401);

    const before = await call("GET", "/api/game/about");
    chk("玩家端默认可见 seed 占位", (before.json.data || []).length >= 1, true);

    const saved = await call("PUT", "/api/admin/about/about", { adminKey: ADMIN_KEY, body: NEW_ABOUT });
    chk("带密钥 PUT → 200", saved.status, 200);
    chk("返回 data 为传入内容", saved.json.data?.data?.terms?.title, "用户协议");
    chk("保存后为草稿（published=false）", saved.json.data?.published, false);

    const draftHidden = await call("GET", "/api/game/about");
    chk("反向：草稿未发布 → 玩家端看不到", (draftHidden.json.data || []).length, 0);

    const published = await call("POST", "/api/admin/about/about/publish", { adminKey: ADMIN_KEY });
    chk("发布 → 200", published.status, 200);
    chk("发布后 publishedData.tip.imageUrl 生效", published.json.data?.data?.tip?.imageUrl, "https://example.com/qr.png");

    const after = await call("GET", "/api/game/about");
    const rec = (after.json.data || []).find(r => r.id === "about");
    chk("发布后玩家端可见", !!rec, true);
    chk("玩家端拿到的是已发布内容", rec?.data?.terms?.title, "用户协议");
  } finally {
    server.kill();
  }
}

console.log(`\n==== about-config: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
