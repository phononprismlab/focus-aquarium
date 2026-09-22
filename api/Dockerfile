# 固定 Node 主版本：lts-slim 会随上游跳大版本，Express 5 与云开发 SDK 在新主版本上可能不兼容。
FROM node:22-bookworm-slim

ENV NODE_ENV=production
# 默认非特权端口。容器以 USER node（非 root）运行，绑 1024 以下的端口会被内核拒绝（EACCES）。
# 服务端还会用 EXTRA_PORTS（默认 80）额外听一个端口，兼容云托管控制台「服务端口」被固定成 80 的情况。
# 改这些值必须同步改控制台的服务端口。
ENV PORT=8080

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 让非 root 的 node 也能绑定 80 这类特权端口。
# 给单个二进制加 CAP_NET_BIND_SERVICE，比让整个容器以 root 运行安全得多。
# 注意：若容器运行时启用了 no-new-privileges（K8s allowPrivilegeEscalation: false），
# 文件能力会被内核忽略，此时 80 仍然绑不上，启动日志会明确报出 EACCES —— 那就把
# 控制台的服务端口改成 8080（服务端默认就在听 8080）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends libcap2-bin \
 && setcap 'cap_net_bind_service=+ep' "$(command -v node)" \
 && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node . .

# 本地磁盘存储时的写入目录。容器重建会丢，生产请改用 STORAGE_DRIVER=cloudbase
# 或把持久卷挂到这个路径并设置 UPLOAD_DIR。
RUN mkdir -p uploads && chown -R node:node uploads

USER node
EXPOSE 8080

# 平台（云托管 / k8s）靠这个判断实例是否真的可用，而不只是进程还在。
# /api/health 现在只回答"进程活着吗"，不等数据层，所以这里能很快通过；
# 窗口放得很宽是因为小规格容器（0.25 核）被 CPU 限流时，冷启动和这次探测都会明显变慢，
# 而一次误判就会让平台把容器判成不健康并重启 —— 重启期间探针只会看到 connection refused，
# 最终表现成"日志里服务明明起来了，部署却失败"。
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
