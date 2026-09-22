// 全量单元测试入口：依次运行各测试文件，任一失败即返回非零退出码。
// 运行：npm test
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ["reward.test.js", "focus-session.test.js", "audio-categories.test.js", "cors.test.js", "health.test.js", "bind-failure.test.js", "runtime-guard.test.js"];

let failed = 0;
for (const file of files) {
  console.log(`\n===== ${file} =====`);
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: "inherit" });
  if (result.status !== 0) failed++;
}

console.log(`\n===== 汇总 =====`);
console.log(failed === 0 ? "全部单元测试通过" : `${failed} 个测试文件失败`);
process.exit(failed === 0 ? 0 : 1);
