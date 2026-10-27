# 运行、迁移与恢复

## 本地进程与容器

仓库根目录运行 `pnpm dev` 前，先复制不覆盖已有文件的 `.env.example`、启动 Compose 的 `db` 服务并执行迁移，详见 README。开发服务器不是生产部署。

```sh
docker compose -f infra/compose.yaml up -d --wait db
pnpm --filter @apple/api db:migrate
pnpm dev
```

使用整栈容器时，API 在启动前运行编译后的迁移脚本。重复迁移校验已应用内容，不清空数据库。网关等待 API readiness，API readiness 检查数据库与 schema。`/api/health` 仅供进程存活检查。

```sh
docker compose -f infra/compose.yaml ps
docker compose -f infra/compose.yaml logs --tail=100 api
docker compose -f infra/compose.yaml down
```

只关闭本项目启动的服务。`down` 保留命名卷；不要使用全局 Docker 清理命令，也不要在排障时删除数据库卷。数据库、API、web 端口分别可用 `POSTGRES_PORT`、`API_PORT`、`WEB_PORT` 调整；本机进程的 `DATABASE_URL`、`APP_ORIGIN` 要随之调整。

## 配置与秘密

开发默认数据库仅绑定回环，密码只用于本地验证，不能复制到真实部署。真实数据库连接串、稳定会话密钥和后续提供方凭据通过安全环境设置注入，不写入前端、不提交、不打印完整环境。

部署域名变化必须同步 `APP_ORIGIN`。TLS、国内 CDN 和入口防护需在客户指定基础设施配置并验证。服务不自动信任任意转发头，也不为绕过跨域错误关闭来源校验。

企业代理的构建环境可使用 Docker 预定义的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` build args；组织 CA 通过 BuildKit 的可选 `registry_ca` secret 提供，例如在已有 `NODE_EXTRA_CA_CERTS` 时使用 `--secret id=registry_ca,src="$NODE_EXTRA_CA_CERTS"`。CA 只在依赖安装步骤临时用于正常 TLS 验证，不被复制进应用镜像。不应关闭证书、签名或校验和验证。Docker 的网络与 DNS 也必须能通过既有代理访问包源，不能假定宿主 shell 可访问就证明构建沙箱可访问。

本任务云端实际构建还需要 host 构建网络，以及把已配置代理的主机映射到其当前 DNS IPv4。以下 Bash 命令使用已有配置，不打印代理认证信息，不把地址或 CA 烘焙进镜像；只适用于已经注入这些配置的本云环境。普通开发电脑优先使用 Compose build。

```sh
export DOCKER_CONFIG=/tmp/apple-docker RELEASE_ID=local-container
mapfile -t apple_proxy_route < <(python - <<'PY'
import os, socket, urllib.parse
host = urllib.parse.urlsplit(os.environ['HTTPS_PROXY']).hostname
if not host:
    raise SystemExit('A configured HTTPS proxy hostname is required')
print(host)
print(socket.gethostbyname(host))
PY
)
for apple_target in api web; do
  docker build --network host \
    --add-host "${apple_proxy_route[0]}:${apple_proxy_route[1]}" \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
    --secret "id=registry_ca,src=$NODE_EXTRA_CA_CERTS" \
    --build-arg "RELEASE_ID=$RELEASE_ID" \
    --target "$apple_target-runtime" -t "apple-lab-$apple_target" \
    -f infra/Dockerfile .
done
API_PORT=3301 WEB_PORT=8080 docker compose -f infra/compose.yaml up -d --no-build --wait
```

上述构建参数已在本任务实际使用并成功构建。若配置缺失或 DNS/授权返回拒绝，应排查该前提，不能关闭校验或改用未授权隧道。当前环境部署和读回验收见 [deployment-acceptance.md](deployment-acceptance.md)。

生产模式拒绝当前 mock。真实适配器尚未实现之前，`NODE_ENV=production` 不能作为可上线能力声明。Compose 显式保留 development，目的是演示和联调测试。

## 数据迁移

迁移文件属于版本历史，已应用文件不得重写。先在独立数据库执行迁移，再运行真实 PostgreSQL 集成测试和回滚兼容性测试。发布前确认旧版 API 能运行于新版 schema；破坏性删除应延后到旧版已退役后。

迁移脚本首期支持当前 schema 初始化，不等于拥有任意版本自动升级框架。后续增加迁移时应扩展版本化迁移列表、校验和测试。

## 本地备份与恢复演练

以下操作仅适用于本地 lab，备份可能包含事件数据，应保存在受控位置。命令从根目录执行，使用新文件避免覆盖旧备份。若恢复校验库已存在，先选用新的数据库名。

```sh
(
  set -eu
  umask 077
  mkdir -p .local-backups
  apple_backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  apple_backup_path=".local-backups/apple-lab-$apple_backup_stamp.dump"
  apple_restore_db="apple_lab_restore_$apple_backup_stamp"
  set -C
  docker compose -f infra/compose.yaml exec -T db pg_dump -U apple -d apple_lab -Fc > "$apple_backup_path"
  test -s "$apple_backup_path"
  docker compose -f infra/compose.yaml exec -T db createdb -U apple "$apple_restore_db"
  docker compose -f infra/compose.yaml exec -T db pg_restore -U apple -d "$apple_restore_db" --exit-on-error < "$apple_backup_path"
  docker compose -f infra/compose.yaml exec -T db psql -U apple -d "$apple_restore_db" -c '\dt'
)
```

若文件或恢复校验库已存在，先检查并改用新名称；不要盲目覆盖或删除。存在备份文件只证明导出，不证明恢复成功。

本次已在当前云端 Linux 对本地开发库完成一次隔离恢复演练（2026-10-27 01:34，Asia/Shanghai）：自定义格式备份 6,784 字节，`pg_restore --exit-on-error` 成功，恢复后检查到 4 条事件及 10 条参与记录；随后只删除本次创建的恢复校验库，源库未修改。备份保存在忽略目录 `.local-backups/`，权限为 0600。这证明该开发快照可恢复，不代表客户生产数据库已完成备份验收。真实环境应使用托管数据库备份、恢复点和访问控制，并定期做隔离恢复。

## 发布与回滚

1. 固定依赖、完成检查并构建一次，记录提交、release 和镜像 digest。
2. 同一制品先进入预发布。执行功能、契约、事件对账及所需真机验收。
3. 生产使用客户审批后的域名、基础设施和真实适配器；本项目不自动采购或发布。
4. 保留上一版 HTML、配置、哈希资源和 API 镜像。不要清空仍可能被旧 HTML 引用的资源。
5. 回滚网关/HTML 与 API 到兼容的已知版本，验证 readiness 和代表性功能。数据库不随代码自动倒退。

当前只有可执行的开发制品与基础流程，未配置客户云、远程发布权限或真实提供方。回滚预案需要在目标预发布环境实际演练后才构成证据。
