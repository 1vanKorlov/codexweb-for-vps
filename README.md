# Codex Web

> 更新时间：2026-08-21
> 本文件记录 Codex Web 的实现、权限边界、数据位置和维护方法。

## 1. 访问地址

- 公网正式地址：
  `https://codex4web.me/codex-ce3a1907b7bb0d9b7d92b76256c39101/`
- 内部/梯子链路地址：
  `https://codex.internal/codex-ce3a1907b7bb0d9b7d92b76256c39101/`
- HTTP 本机监听：`127.0.0.1:8081`
- HTTPS 本机监听：`127.0.0.1:8443`
- 公网入口：`codex-tls-router.service` 监听 `0.0.0.0:443`

公网域名的 DNS A 记录指向当前新 VPS `192.236.214.144`。`codex4web.me` 使用 Let’s Encrypt 正式证书，证书由 acme.sh 自动续期；公网访问不需要先连接服务器梯子。

## 2. 服务组成

| 组件 | 位置/服务 | 作用 |
|---|---|---|
| 前端 | `/opt/codex-web/index.html` | 响应式手机/电脑界面、会话、设置、消息流展示 |
| 后端 | `/opt/codex-web/server.js` | 登录、会话、对话持久化、Codex 调用、SSE/NDJSON 流 |
| SNI 路由 | `/opt/codex-web/tls-router.js` | 将 `codex4web.me`/`codex.internal` 转到 8443，其余连接转到 Xray 9443 |
| systemd | `codex-web.service` | 启动 Web 后端 |
| systemd | `codex-tls-router.service` | 启动公网 443 路由 |
| 配置 | `/etc/default/codex-web` | 端口、路径、证书和数据目录 |
| 工作目录 | `/root` | Codex CLI 的执行目录 |

修改 `index.html` 后必须重启 `codex-web`，因为后端会在启动时读取并缓存 HTML。修改 `server.js` 或 TLS 路由也需要重启对应服务。

## 3. 数据和敏感文件

数据目录为 `/var/lib/codex-web`，当前由 root 使用，文件权限为 root 私有：

| 文件/目录 | 内容 |
|---|---|
| `conversations.json` | 全部账号的对话、助手最终回答、压缩后的过程事件和图片元数据 |
| `runs.json` | 运行任务的 ID、状态和断线恢复所需的压缩过程事件；服务重启后会把未完成任务标记为中断 |
| `users.json` | 用户名、角色、密码盐值和密码哈希；不保存明文密码 |
| `sessions.json` | “自动登录”持久会话的哈希和过期时间 |
| `registration-keys.json` | 管理员生成的一次性注册密钥 |
| `registration.key` | 旧版单密钥文件，兼容读取；不要公开 |
| `uploads/` | 用户上传的 PNG/JPEG/GIF 图片，按会话权限提供访问 |

证书目录：`/etc/codex-web/tls/`

- 公网证书：`codex4web.me.fullchain.crt`、`codex4web.me.key`
- 内部/旧版证书材料：`server.crt`、`server.key`、`ca.crt`、`ca.key`、`ca.cer`

不要把密码、Codex 登录凭据、注册密钥、会话文件、证书私钥提交到 Git 或发给其他人。root 密码和 3X-UI 凭据只保留在服务器说明的私密副本中。

## 4. 登录、账号和权限

### root 管理员

- Web 用户名：`root`
- 角色：`admin`
- 已有旧对话已迁移到 root 账号
- root 不需要注册密钥
- 管理员设置可以查看用户并生成一次性注册密钥

### 普通用户

- 注册需要管理员生成的一次性注册密钥
- 用户名限制为 3–32 位字母、数字、下划线或短横线
- 密码长度限制为 8–200 个字符
- 普通用户不显示管理员设置
- 普通用户只能读取文件、查看状态和执行不改变系统的诊断命令
- 禁止修改/创建/删除/移动文件，安装软件，修改配置，重启或管理服务

认证使用 `codex_session` Cookie。勾选“自动登录”时会写入持久会话，服务重启后仍可恢复；未勾选时只保留临时会话。登录失败有简单限流。

### 对话隔离

每个对话都带有 `ownerId`，只有所属账号可以查看、发送消息、分支、删除和读取附件。管理员也不会自动看到其他用户的对话。旧版没有 owner 的历史对话已迁移到 root。

目前账号还没有映射为独立 Linux 用户；所有 Web 请求仍由 root 运行的 Node 服务接收。普通用户依靠 Codex 的只读沙箱限制，管理员使用完全访问模式。因此这不是完整的多租户隔离系统，不要给不完全信任的人管理员账号。

## 5. Codex 执行和并行

- 使用 `/usr/local/bin/codex exec --ephemeral --json` 调用 Codex。
- 管理员会话使用完全访问模式。
- 普通用户会使用 `--sandbox read-only`，并在系统提示中再次声明只读边界。
- 同一个对话一次只能运行一条消息，避免上下文和停止操作互相干扰。
- 不同对话、不同用户可以并行运行；运行任务保存在后端 `activeRuns` Map 中。
- `/api/chat/stop` 按对话 ID停止对应任务。
- 前端通过 `/api/chat/stream` 接收过程事件，任务结束后保存最终回答和压缩后的过程记录。
- Codex 单个任务最长运行 60 分钟；流连接本身有心跳，断线后不影响后台任务。
- 网络错误或 Codex 异常也会保存为错误消息，刷新后不会凭空消失。
- 流式连接断开后，Codex 子进程仍会继续运行；前端会在重新显示页面、网络恢复或重新打开对话时轮询任务状态并恢复过程/最终消息。
- 服务端每 15 秒发送一次流心跳；运行任务的状态和过程事件会同步写入 `runs.json`，服务重启造成的未完成任务会显示为明确的中断消息。
- 历史对话默认不加载完整终端/工具过程：对话接口只返回正文、事件数量和文件变更摘要；用户点击过程折叠栏时，前端才按消息请求并分批渲染完整事件，避免大对话首次打开卡顿。

服务器只有 1 vCPU、约 1G 内存。虽然代码支持并行，但不建议同时运行多个大型任务；并行任务过多会抢占内存并使用 Swap。

## 6. 当前界面行为

- 电脑端：Enter 发送，Shift+Enter 换行。
- 手机端：保留移动端输入习惯，不强制改成电脑端 Enter 发送。
- 对话标题使用首条用户问题，不再请求模型额外生成标题；历史标题迁移时也会从首条用户消息补齐。
- 终端、工具调用和中间说明以过程区域展示；命令组默认折叠，点击后查看具体命令和输出。
- 同一批次的多个命令会归并显示；正在处理时显示“思考中”，完成后才显示折叠入口。
- 用户消息和 Codex 消息分左右布局；复制、分支、URL 卡片和文件改动摘要在最终消息附近显示。
- 文件改动卡片由执行前后的工作区快照和文件内容差异计算 `+xx/-xx`，不是简单用总行数相减。新建文件只显示绿色新增行数；多文件会归并为一个卡片并列出路径。
- 普通用户看不到管理员设置；设置中的“外观”负责深色/浅色模式。

文件快照会跳过 `.codex`、`.vscode-server`、缓存、`.git`、`node_modules` 等大目录；单文件和过程记录也有大小限制，避免对话文件无限增长。

## 7. 主要接口

所有 `/api/*` 接口（认证接口除外）都需要登录，并按当前用户校验对话权限。

| 接口 | 作用 |
|---|---|
| `GET /api/auth/status` | 检查登录状态 |
| `POST /api/auth/login` | 用户名密码登录 |
| `POST /api/auth/register` | 使用一次性注册密钥注册 |
| `POST /api/auth/logout` | 注销当前会话 |
| `GET /api/conversations` | 获取当前用户的对话列表 |
| `POST /api/conversations` | 创建对话 |
| `GET /api/conversations/:id` | 读取对话正文、过程摘要和文件变更摘要 |
| `GET /api/conversations/:id/run-events/:messageId` | 按需读取某条助手消息的完整过程事件 |
| `GET /api/conversations/:id/run` | 轻量读取运行状态和增量过程事件 |
| `PATCH /api/conversations/:id/settings` | 保存模型和推理强度 |
| `POST /api/conversations/:id/branch` | 创建分支 |
| `DELETE /api/conversations/:id` | 删除当前用户的对话和附件 |
| `POST /api/chat/stream` | 流式发送消息 |
| `POST /api/chat` | 非流式发送消息，兼容备用调用 |
| `POST /api/chat/stop` | 停止当前用户可访问的运行任务 |
| `GET /api/models` | 获取模型目录 |
| `GET /api/admin/users` | 管理员查看用户 |
| `POST /api/admin/registration-keys` | 管理员生成一次性注册密钥 |
| `PATCH /api/admin/users/:id` | 管理员启用/禁用用户 |

## 8. 代理、域名和 TLS 排障

公网 443 同时承担 Codex Web 和 VLESS Reality：

```text
客户端 -> 192.236.214.144:443 -> codex-tls-router
  SNI=codex4web.me/codex.internal -> 127.0.0.1:8443 -> Codex Web
  其他 SNI                         -> 127.0.0.1:9443 -> Xray
```

手机 Clash 配置中必须让 Codex 域名直连，且规则放在 `MATCH,PROXY` 之前：

```yaml
rules:
  - DOMAIN-SUFFIX,codex4web.me,DIRECT
  - DOMAIN,codex.internal,PROXY
  - MATCH,PROXY
```

原因是：若把 `codex4web.me` 也送进同一台 VPS 的代理入口，Reality 连接的 SNI 通常是 `www.cloudflare.com`，443 路由器会把它分给 Xray，浏览器就会表现为打不开或 TLS EOF。修改手机实际使用的 Clash 配置后，需要更新配置并重载代理。

## 9. 维护和检查

```bash
# 语法检查
node --check /opt/codex-web/server.js
node --check /opt/codex-web/tls-router.js

# 重启/状态/日志
systemctl restart codex-web
systemctl status codex-web --no-pager
journalctl -u codex-web -n 100 --no-pager

systemctl restart codex-tls-router
systemctl status codex-tls-router --no-pager
journalctl -u codex-tls-router -n 100 --no-pager

# 端口
ss -ltnp | grep -E ':(443|8443|8081|9443)\b'

# 本机和公网 HTTPS
curl -kI https://127.0.0.1:8443/codex-ce3a1907b7bb0d9b7d92b76256c39101/
curl -4 -IksS https://codex4web.me/codex-ce3a1907b7bb0d9b7d92b76256c39101/

# 应用健康状态（需带登录 Cookie 才能获得完整结果）
curl http://127.0.0.1:8081/codex-ce3a1907b7bb0d9b7d92b76256c39101/api/health
```

修改前先备份：

```bash
cp /opt/codex-web/index.html /opt/codex-web/index.html.bak.$(date +%F-%H%M%S)
cp /opt/codex-web/server.js /opt/codex-web/server.js.bak.$(date +%F-%H%M%S)
cp /var/lib/codex-web/conversations.json /var/lib/codex-web/conversations.json.bak.$(date +%F-%H%M%S)
```

## 10. 后续可扩展项

“注册账号时同步创建同名 Linux 用户、独立 home 和 workspace、按 Linux 用户运行 Codex”目前尚未实现。若以后开放给更多人使用，应先设计 Linux 用户映射、进程权限、workspace 白名单、资源限制和删除/禁用账号策略，再实现该功能；仅增加 Web 登录不能替代系统级隔离。
