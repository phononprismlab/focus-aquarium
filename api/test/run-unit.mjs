// 全量单元测试入口：依次运行各测试文件，任一失败即返回非零退出码。
// 运行：npm test
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ["reward.test.js", "focus-session.test.js", "focus-settle-writeback.test.js", "focus-resume.test.js", "audio-categories.test.js", "shop-sound-items.test.js", "ambient-audio.test.js", "image-upload.test.js", "webp-transform.test.js", "storage-pg.test.js", "cors.test.js", "health.test.js", "ready.test.js", "bind-failure.test.js", "runtime-guard.test.js", "admin-resolution.test.js",
  "seed-migration.test.js",
  "fish-assembly.test.js",
  "fish-animation.test.js",
  "tags.test.js",
  "events.test.js",
  "events-api.test.js",
  "admin-events-page.test.js",
  "storage-hardening.test.js",
  "body-limit.test.js",
  "focus-reward-flow.test.js",
  "player-usability.test.js",
  "admin-decoration-form.test.js",
  "account.test.js",
  "account-client.test.js",
  "account-delete.test.js",
  "feedback.test.js",
  "embed-guard.test.js",
  "cloud-save.test.js",
  "player-field-registry.test.js",
  "player-cloud-sync.test.js",
  "sync-code.test.js",
  "focus-stats.test.js",
  "sync-guide.test.js",
  "focus-stats-ui.test.js",
  "admin-users.test.js",
  "tracking.test.js",
  "player-profile.test.js",
  "player-profile-ui.test.js",
  "background-visual.test.js",
  "shop-preview.test.js",
  "dev-panel-gate.test.js",
  "focus-membership.test.js",
  "schema.test.js",
  "barcode.test.js",
  "receipt-paper.test.js",
  "event-log.test.js",
  "tank-depth.test.js",
  "shop-sort.test.js",
  "focus-status-position.test.js",
  "player-tank-ui.test.js",
  "admin-pages-ux.test.js",
  "save-export.test.js",
  "save-restore.test.js",
  "concurrency-anchors.test.js",
  "about-config.test.js",
  "ops-config.test.js",
  "player-ops-ui.test.js",
  "grants.test.js",
  "bubble-authority.test.js",
  "t25-e2e.test.js"];

let failed = 0;
// ⚠️ 只报数量的话，失败后必须回翻整份日志找是哪几个文件 —— 这里直接记名字。
//    status 为 null 表示被信号杀掉（超时 / 崩溃），也要区分出来。
const failedFiles = [];
for (const file of files) {
  console.log(`\n===== ${file} =====`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: "inherit" });
  const elapsed = Date.now() - started;
  if (result.status !== 0) {
    failed++;
    const reason = result.status === null ? `signal=${result.signal}` : `exit=${result.status}`;
    failedFiles.push(`${file}（${reason}，${(elapsed / 1000).toFixed(1)}s）`);
  }
}

console.log(`\n===== 汇总 =====`);
if (failed === 0) {
  console.log(`全部单元测试通过（${files.length} 个文件）`);
} else {
  console.log(`${failed} / ${files.length} 个测试文件失败：`);
  for (const name of failedFiles) console.log(`  - ${name}`);
  console.log("提示：若断言全 PASS 却非 0 退出，多半是沙箱起进程抖动（服务没能在超时内起来），单独重跑该文件确认。");
}
process.exit(failed === 0 ? 0 : 1);
