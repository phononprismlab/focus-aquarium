-- 鱼儿乐水族馆 · 业务表结构（CloudBase PostgreSQL）
--
-- 为什么要有这个文件：
--   这 4 张表原来只写在交付文档里，靠人在控制台手工建。结果是
--   ① 换环境（或本地起一个）没法一键重建；② 表结构没有任何版本记录，
--   代码加了列、线上却没加，只有跑到那条 SQL 才 500。
--   现在这里是唯一权威，`test/schema.test.js` 会盯着它和代码别走偏。
--
-- ⚠️ 本环境是 **PostgreSQL**，不是 MySQL：
--     `app.rdb()` 的 `IMySqlClient` 只是 SDK 的历史命名。
--     不要用 TINYINT / LONGTEXT / DEFAULT CHARSET / KEY idx_xxx，PG 全都不认。
--
-- 执行方式（任选）：
--   1) 云开发控制台 → 数据库 → SQL 编辑器，整段贴进去执行；
--   2) 控制台没有 SQL 入口时，按下面的列清单用可视化建表逐个建
--      （表名必须逐字一致，且必须与 `fishtank_configs` 建在同一个库）。
--
-- 全部语句幂等（IF NOT EXISTS），重复执行安全。
--
-- 🔴 两条硬约束，改这个文件前先读：
--   1) **不要建外键**。`focus_records.user_id` 服务端刻意不校验存在性
--      （未登录也能专注），建了外键会静默丢数据。
--   2) `bigint` 千万别写成 `integer`：存的是毫秒时间戳（约 1.7×10¹²），
--      int4 上限 21 亿，塞进去直接溢出。
--
-- RLS：控制台里「启用行级安全」保持勾选、**不要写任何策略**。
--      服务端用 CLOUDBASE_APIKEY（= service_role，官方明确 BYPASSRLS），
--      玩家端从不直连数据库，所以没有任何策略需要写。

-- ===== 1. 用户 =====
-- 账号是 CloudBase 自定义登录签发的 uid（`u_` + 28 hex = 30 字符，硬上限 32）。
CREATE TABLE IF NOT EXISTS public.users (
  user_id        varchar(32)  NOT NULL,
  sync_code_hash varchar(64)  NOT NULL DEFAULT '',
  nickname       varchar(32)  NOT NULL DEFAULT '',
  cohort         varchar(16)  NOT NULL DEFAULT 'public',
  is_supporter   smallint     NOT NULL DEFAULT 0,
  supporter_note text         NULL,
  created_at     bigint       NOT NULL DEFAULT 0,
  last_seen_at   bigint       NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id)
);

-- ===== 2. 存档 =====
-- `data` 存整包 JSON 文本（服务端整体读写，不拆列）→ 必须是 text，不能是 varchar。
-- 存档契约见 player-store.js：顶层是首字母大写的
-- { saveVersion, PlayerData, AquariumData, Settings }。
CREATE TABLE IF NOT EXISTS public.saves (
  user_id      varchar(32) NOT NULL,
  data         text        NOT NULL,
  save_version varchar(16) NOT NULL DEFAULT '',
  client_ts    bigint      NOT NULL DEFAULT 0,
  updated_at   bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id)
);

-- ===== 3. 专注记录 =====
-- `settled_at = 0` 表示「已开始、未结算」，所以这张表同时兼作会话表。
-- `natural` = 是否自然走完（服务端按真实耗时判定，不采信客户端声明）。
CREATE TABLE IF NOT EXISTS public.focus_records (
  id              varchar(36) NOT NULL,
  user_id         varchar(32) NOT NULL DEFAULT '',
  planned_minutes integer     NOT NULL DEFAULT 0,
  counted_minutes integer     NOT NULL DEFAULT 0,
  reward          integer     NOT NULL DEFAULT 0,
  natural         smallint    NOT NULL DEFAULT 0,
  started_at      bigint      NOT NULL DEFAULT 0,
  settled_at      bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

-- 后台用户列表与专注聚合都要按 user_id 过滤，再按时间排。
CREATE INDEX IF NOT EXISTS idx_focus_user ON public.focus_records (user_id, started_at);

-- ===== 4. 埋点事件 =====
-- 🔴 `id` 是 varchar 主键、**由应用层生成**（`te_<ts36>_<rand6>`，约 23 字符）。
--    原因：控制台的可视化建表建不出 bigserial，而这张表要落 4 个事件的流水。
--    列长留 32 以上，给以后换 ID 方案留余量。
-- 🔴 `detail` 必须是 text：购买事件会把 {itemId, paid} 的 JSON 塞进来。
-- `event` 目前只会有 open / focus_start / focus_complete / purchase 四个值
-- （open 由客户端上报，其余三个由服务端在权威时机落库）。
CREATE TABLE IF NOT EXISTS public.tracking_events (
  id      varchar(32) NOT NULL,
  user_id varchar(32) NOT NULL DEFAULT '',
  event   varchar(32) NOT NULL,
  detail  text        NOT NULL DEFAULT '',
  at      bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

-- 埋点概览要按时间窗（今日 / 最近 7 天）过滤，按事件分组。
CREATE INDEX IF NOT EXISTS idx_tracking_event_at ON public.tracking_events (event, at);

-- ===== 自检 =====
-- 建完跑一下，应该看到 4 行：
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('users','saves','focus_records','tracking_events')
--   ORDER BY table_name;
