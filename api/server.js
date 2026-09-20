import cors from "cors";
import express from "express";
import { createRepository } from "./repository.js";

const app = express();
const port = Number(process.env.PORT || 80);
let repository;

const isProduction = process.env.NODE_ENV === "production";
const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length ? configuredOrigins : (isProduction ? [] : ["null", "http://localhost:3000", "http://127.0.0.1:3000"]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS origin not allowed"));
  }
}));
app.use(express.json({ limit: "2mb" }));

const types = new Set(["decorations", "fish", "focus"]);
const idFor = (type, data) => type === "fish" ? data.fishid : type === "focus" ? "focus" : data.id;
const validate = (type, data) => {
  if (!data || typeof data !== "object") return "请求体必须是对象";
  if (type === "decorations" && (!data.id || !data.category || !data.name)) return "商品必须包含 id、category、name";
  if (type === "fish" && (!data.fishid || !data.name)) return "鱼类必须包含 fishid、name";
  if (type === "focus" && (!Number.isFinite(Number(data.minFocusDuration)) || !Array.isArray(data.rewardTiers))) return "专注配置必须包含 minFocusDuration 和 rewardTiers";
  return null;
};
const records = type => repository.list(type, false);
const sendError = (res, error) => res.status(500).json({ error: error.message || "服务器错误" });

app.get("/api/health", (req, res) => res.json({ ok: true, storage: process.env.CLOUDBASE_ENV_ID ? "cloudbase" : "memory" }));

for (const type of types) {
  app.get(`/api/admin/${type}`, async (req, res) => {
    try { res.json({ data: await records(type) }); } catch (error) { sendError(res, error); }
  });
  app.get(`/api/game/${type}`, async (req, res) => {
    try {
      const published = await repository.list(type, true);
      res.json({ data: published.map(record => ({ ...record, data: record.publishedData || record.data })) });
    } catch (error) { sendError(res, error); }
  });
}

app.put("/api/admin/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!types.has(type)) return res.status(404).json({ error: "未知配置类型" });
  const errorMessage = validate(type, req.body);
  if (errorMessage) return res.status(400).json({ error: errorMessage });
  if (idFor(type, req.body) !== id) return res.status(400).json({ error: "路径 id 与请求体 id 不一致" });
  try { res.json({ data: await repository.save(type, id, req.body) }); } catch (error) { sendError(res, error); }
});

app.post("/api/admin/:type", async (req, res) => {
  const { type } = req.params;
  if (!types.has(type)) return res.status(404).json({ error: "未知配置类型" });
  const errorMessage = validate(type, req.body);
  if (errorMessage) return res.status(400).json({ error: errorMessage });
  const id = idFor(type, req.body);
  try { res.status(201).json({ data: await repository.save(type, id, req.body) }); } catch (error) { sendError(res, error); }
});

app.delete("/api/admin/:type/:id", async (req, res) => {
  if (!types.has(req.params.type)) return res.status(404).json({ error: "未知配置类型" });
  try { await repository.remove(req.params.type, req.params.id); res.status(204).end(); } catch (error) { sendError(res, error); }
});

app.post("/api/admin/:type/:id/publish", async (req, res) => {
  if (!types.has(req.params.type)) return res.status(404).json({ error: "未知配置类型" });
  try {
    const data = await repository.publish(req.params.type, req.params.id);
    if (!data) return res.status(404).json({ error: "配置不存在" });
    res.json({ data });
  } catch (error) { sendError(res, error); }
});

app.post("/api/admin/assets", (req, res) => res.status(501).json({ error: "资源上传将在配置 API 接通后实现" }));

app.listen(port, "0.0.0.0", () => {
  console.log(`Fishtank API listening on port ${port}`);
});

createRepository()
  .then(instance => {
    repository = instance;
    console.log("Repository initialized");
  })
  .catch(error => {
    console.error("Repository initialization failed", error);
    process.exitCode = 1;
  });
