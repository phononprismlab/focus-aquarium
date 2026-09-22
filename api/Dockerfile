# 固定 Node 主版本：lts-slim 会随上游跳大版本，Express 5 与云开发 SDK 在新主版本上可能不兼容。
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=80

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# 本地磁盘存储时的写入目录。容器重建会丢，生产请改用 STORAGE_DRIVER=cloudbase
# 或把持久卷挂到这个路径并设置 UPLOAD_DIR。
RUN mkdir -p uploads && chown -R node:node uploads

USER node
EXPOSE 80

# 平台（云托管 / k8s）靠这个判断实例是否真的可用，而不只是进程还在。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
