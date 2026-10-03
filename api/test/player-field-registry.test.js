// PlayerData 字段注册表的回归测试。
//
// 这个文件盯的是**「以后往 PlayerData 加字段不会再被静默丢掉」**这条机制 ——
// 图鉴、成就、连续打卡都会走同一条路。四件事：
//   1) 注册表结构完整：每个字段都显式声明 source 与 signed，不留默认值。
//   2) 注册了就能活下来（服务端 + 客户端两个方向都要），没注册的一律丢弃。
//   3) 三个老字段的分权行为与注册表声明一致（source 决定以谁为准）。
//   4) 🔴 signed 标记必须与前端 computeSaveSignature 实际签的字段一致 ——
//      加了 signed:true 的字段却忘了改签名，会让所有老存档算不出匹配签名
//      → 被判 tampered → 泡泡清零。这条断言就是拦这个的。
//
// 运行：node test/player-field-registry.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYER_FIELDS, mergeSaveForWrite } from "../player-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
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
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${ok ? "" : "  " + detail}`);
  ok ? pass++ : fail++;
}

const baseSave = () => ({
  saveVersion: "0.2.0",
  PlayerData: {
    bubbles: 100,
    isMember: false,
    inventory: { fish: { fish001: 3 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} }
  },
  AquariumData: { fish: [{ itemId: "fish001", instanceId: "f1" }], decoration: "", background: "", sand: "", ambientSound: "" },
  Settings: { audio: {} }
});

console.log("\n--- 1. 注册表结构 ---");
{
  const keys = Object.keys(PLAYER_FIELDS);
  chk("现有三个字段都在表里", keys.slice().sort(), ["bubbles", "inventory", "isMember"]);
  chkTrue("每个字段都声明了 source（client / server）",
    keys.every(k => ["client", "server"].includes(PLAYER_FIELDS[k].source)),
    keys.map(k => `${k}:${PLAYER_FIELDS[k].source}`).join(" "));
  chkTrue("每个字段都显式声明了 signed（不能靠默认值）",
    keys.every(k => typeof PLAYER_FIELDS[k].signed === "boolean"),
    keys.map(k => `${k}:${PLAYER_FIELDS[k].signed}`).join(" "));
  chkTrue("每个字段都有 merge 函数",
    keys.every(k => typeof PLAYER_FIELDS[k].merge === "function"));
}

console.log("\n--- 2. 注册了就能活下来（图鉴/成就将来走的就是这条路）---");
{
  // 模拟「以后加一个图鉴字段」：只往注册表加一条，mergeSaveForWrite 一个字都不用动。
  PLAYER_FIELDS.__probe_dex = {
    source: "client",
    signed: false,
    merge: (server, client) => {
      const out = {};
      for (const source of [server.__probe_dex, client.__probe_dex]) {
        if (source && typeof source === "object" && !Array.isArray(source)) {
          for (const [id, at] of Object.entries(source)) {
            if (!(id in out)) out[id] = at;
          }
        }
      }
      return out;
    }
  };
  try {
    const stored = baseSave();
    stored.PlayerData.__probe_dex = { fish001: 1000 };
    const incoming = baseSave();
    incoming.PlayerData.__probe_dex = { fish002: 2000 };

    const merged = mergeSaveForWrite(stored, incoming);
    chk("新注册的字段在「已有存档」分支活下来了",
      Object.keys(merged.save.PlayerData).slice().sort(),
      ["__probe_dex", "bubbles", "inventory", "isMember"]);
    chk("服务端已解锁的条目没丢", merged.save.PlayerData.__probe_dex.fish001, 1000);
    chk("客户端新解锁的条目被接受", merged.save.PlayerData.__probe_dex.fish002, 2000);

    const first = mergeSaveForWrite(null, incoming);
    chk("首次同步分支也活下来了", first.save.PlayerData.__probe_dex.fish002, 2000);
  } finally {
    delete PLAYER_FIELDS.__probe_dex;
  }
  chk("探针字段已清理（不污染后面的断言）", "__probe_dex" in PLAYER_FIELDS, false);
}

console.log("\n--- 3. 没注册的键一律丢弃（客户端塞不进垃圾）---");
{
  const incoming = baseSave();
  incoming.PlayerData.evil = { hacked: true };
  // 用「下调泡泡」当已注册字段的探针：泡泡已改为客户端只能减（上浮会被打回服务端现值），
  // 所以只有下调才能证明这个键真的走了 merge，而不是被整条丢掉。
  incoming.PlayerData.bubbles = 50;

  const merged = mergeSaveForWrite(baseSave(), incoming);
  chk("已有存档：没注册的键被丢弃", "evil" in merged.save.PlayerData, false);
  chk("已有存档：已注册的字段照常生效（下调放行）", merged.save.PlayerData.bubbles, 50);

  const first = mergeSaveForWrite(null, incoming);
  chk("首次同步：没注册的键也被丢弃", "evil" in first.save.PlayerData, false);
  chk("首次同步：已注册的字段照常生效", first.save.PlayerData.bubbles, 50);
}

console.log("\n--- 4. 三个老字段的分权与注册表声明一致 ---");
{
  const incoming = baseSave();
  incoming.PlayerData = {
    bubbles: 60,
    isMember: true,
    inventory: { fish: { fish001: 999 }, decorations: {}, backgrounds: {}, sands: {}, sounds: {} }
  };
  const merged = mergeSaveForWrite(baseSave(), incoming);
  // bubbles 是特例：客户端能减（买东西要推更小的余额），不能加。这里提交 60 < 服务端 100。
  chk("bubbles 客户端可下调", merged.save.PlayerData.bubbles, 60);
  chk("isMember 声明 server → 客户端改不动", merged.save.PlayerData.isMember, false);
  chk("inventory 声明 server → 客户端改不动", merged.save.PlayerData.inventory.fish.fish001, 3);
  chk("被忽略的 server 权威字段记了 2 条",
    merged.problems.filter(p => p.includes("忽略了客户端提交")).length, 2);

  // 反向：同一份内容把泡泡抬到 120 → 增量被忽略，回落到服务端现值，并留下记录。
  const raised = baseSave();
  raised.PlayerData = { ...baseSave().PlayerData, bubbles: 120 };
  const raisedMerged = mergeSaveForWrite(baseSave(), raised);
  chk("bubbles 上浮被打回服务端现值", raisedMerged.save.PlayerData.bubbles, 100);
  chkTrue("上浮有记录",
    raisedMerged.problems.some(p => p.includes("泡泡只允许服务端增加")),
    raisedMerged.problems.join(" / "));

  // 首次同步不记「忽略」—— 那一步本来就是以客户端为准，不存在被忽略。
  const first = mergeSaveForWrite(null, incoming);
  chk("首次同步不记「忽略了客户端提交」",
    first.problems.filter(p => p.includes("忽略了客户端提交")).length, 0);
}

console.log("\n--- 5. 🔴 signed 标记必须与前端签名实现一致 ---");
{
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const match = html.match(/const payload = JSON\.stringify\(\{([\s\S]*?)\}\);/);
  chkTrue("找到了前端 computeSaveSignature 的 payload",
    Boolean(match),
    "没匹配到 —— 签名实现可能被重构了，这条断言要跟着改");

  const signedInClient = match
    ? [...match[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]).slice().sort()
    : [];
  const declaredSigned = Object.keys(PLAYER_FIELDS).filter(k => PLAYER_FIELDS[k].signed).slice().sort();
  chk("注册表 signed:true 的字段 == 前端实际签名的字段", declaredSigned, signedInClient);
  console.log("   （加 signed:true 的新字段必须同时升签名版本 + 写迁移：");
  console.log("     签名算法一变，所有老存档都算不出匹配签名 → 被判 tampered → 泡泡清零）");
}

console.log("\n----");
console.log(`player-field-registry.test: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
