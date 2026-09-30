# 密聊 · 加密隐私聊天（Web）

类 Telegram 的私人端到端加密聊天网页应用。陌生 IP 连登录页都看不到；消息在浏览器里加密，服务器只存密文。

## 文档

| 文档 | 给谁看 |
|---|---|
| [docs/使用手册.md](docs/使用手册.md) | 使用密聊的每个人 |
| [docs/运维手册.md](docs/运维手册.md) | 服务器管理员：部署、升级、备份、排错 |
| [CHANGELOG.md](CHANGELOG.md) | 各版本改了什么 |
| [docs/开发文档.md](docs/开发文档.md) | 设计规范（安全要求） |
| [docs/实现进度.md](docs/实现进度.md) | 技术实现记录、与规范的差距 |

当前版本：**v1.0.0**。

> ⚠️ 未经独立第三方安全审计。每个版本发布前做内部安全审查、自动化测试和依赖漏洞扫描，详见 [docs/安全设计.md](docs/安全设计.md)。

## 当前进度

| 里程碑 | 状态 |
|---|---|
| M0 脚手架（monorepo、SQLite 迁移、Docker） | ✅ |
| M1 IP 准入 + 账号 + 管理后台 | ✅ 准入、邀请注册、OPAQUE 登录、24 词恢复、会话、后台 |
| M2 端到端加密私聊 | ✅ |
| M3 群组 + 邀请 | ✅ 群聊、角色、签名的成员变更链、原子密钥轮换、群邀请（管理员签名入群）、名片链接 |
| M4 消息能力 | ✅ 回复、编辑、转发、加密表情回应、置顶、@提及、Markdown（剧透/代码等） |
| M5 删除体系 | ✅ 仅我删除 / 为双方删除 / 清空双方 / 删除聊天 / 阅后即焚 |
| M6 媒体 | ✅ 加密图片/视频/音频/文件（≤100 MB）、语音消息、去除照片 EXIF、粘贴/拖拽 |
| M7 体验 | ✅ 本机加密索引的全文搜索、离线只读模式、PWA、不含内容的推送通知、恢复词重新生成 |
| M8 加固上线 | ✅ 已部署到生产（宝塔 + systemd）、每日备份与恢复演练、异地备份；🟡 独立安全审查未做 |
| v0.3–v1.0 | ✅ 私密对话（X3DH + 双棘轮，前向保密）、发布签名、服务器自检、通话（一对一 / 群）、投票、定时、贴纸、两步验证 / 通行密钥、聊天列表整理、加密头像、共享内容、个人数据备份、注销账号等，见 CHANGELOG |

## 本地开发

需要 Node.js 22+。

```bash
npm install
# 初始化：设置访问密码 + 生成一次性管理员注册链接（开发时 origin 用 Vite 地址）
npm run init -- --password '至少8位的访问密码' --origin http://localhost:5173
# 开发时本机 IP 是 127.0.0.1，也可以直接放行：
npm run allow-ip -- 127.0.0.1
# 两个终端分别运行：
npm run dev -w server     # API + WebSocket，端口 3000
npm run dev -w web        # 前端，端口 5173（代理到 3000）
```

打开 init 打印出来的管理员链接 → 注册管理员 → 在「☰ → 管理后台 → 注册邀请」里给朋友生成邀请链接。

> 开发环境 Cookie 需要 `COOKIE_SECURE=0`（http 访问时），例如 `COOKIE_SECURE=0 npm run dev -w server`。

## 测试

```bash
npm test                  # 后端接口 + 加密测试
npm run build -w web && bash e2e/run.sh   # 浏览器端到端测试（多浏览器、多 IP）
```

覆盖：IP 准入与封禁、IPv6 /64 匹配、伪造 X-Forwarded-For、邀请注册、OPAQUE 登录（错误密码、**证明重放被拒**、用户名枚举响应一致）、改密码踢下线、**24 词恢复并使旧会话失效**、私钥备份、消息加解密与篡改检测、**数据库中搜不到明文**、单方面删除/清空、编辑权限、签名的成员变更（伪造签名/越权被拒、**模拟恶意服务器偷加成员被检测**）、原子密钥轮换（新成员看不到旧消息）、群邀请由管理员签名入群、WebSocket 推送与 IP 拒绝、管理员审批、OPAQUE 服务器密钥被替换时拒绝启动、加密附件（非成员不可下载、篡改/截断检出、磁盘无明文、随消息删除）、加密表情回应、置顶。浏览器测试额外覆盖：图片/文件/语音收发与下载核对、@提及、转发、Markdown、本地搜索（IndexedDB 无明文、删除后搜不到）、断网离线模式、恢复词重新生成。推送：只推离线成员、内容为空、节流、失效订阅清理。

## 部署（Docker）

```bash
cd deploy
# 0. 生成 OPAQUE 服务器密钥，写进 deploy/.env（之后永远不要改；也不要和数据库备份放在一起）
echo "OPAQUE_SERVER_SETUP=$(docker run --rm node:22-slim npx -y @serenity-kit/opaque@1.1.0 create-server-setup)" > .env
# （可选）推送用的 VAPID 密钥，不设置则自动生成并保存在数据库里
docker run --rm node:22-slim npx -y web-push generate-vapid-keys --json   # 把结果写成 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
# 1. 编辑 Caddyfile 和 docker-compose.yml，把 chat.example.com 换成你的域名
docker compose up -d --build
docker compose exec app node server/dist/scripts/init.js --password '你的访问密码' --origin https://你的域名
```

打开输出的管理员链接即可（链接同时会放行你当前的 IP）。

应急：
- 管理员自己被挡在门外：`docker compose exec app node server/dist/scripts/allow-ip.js <你的IP>`
- 再要一个管理员邀请：`docker compose exec app node server/dist/scripts/init.js --admin-invite --origin https://你的域名`

数据全部在 `deploy/data/app.db`（SQLite），备份这个目录即可（内容为密文和 OPAQUE 记录）。

> 从 v0.1 升级：旧开发库里的账号无法再登录（认证方式换成了 OPAQUE），请删除 `data/` 后重新 init。

## 目录

```
server/   Fastify + Socket.IO + SQLite
  src/gate.ts      IP 准入（白名单、访问密码、封禁、审批）+ 独立验证页
  src/auth.ts      注册/登录/会话/设备管理
  src/chats.ts     聊天、成员、消息、删除、密钥分发/轮换
  src/invites.ts   邀请链接/邀请码
  src/blobs.ts     加密附件上传/下载/清理
  src/membership.ts 签名成员变更规则（与前端共用同一套规则）
  src/push.ts      Web Push（内容固定为“有新消息”）
  src/sync.ts      本机缓存的删除同步
  src/admin.ts     管理后台 API
  src/passkey.ts / totp.ts  两步验证（通行密钥 / 验证器 App）
  src/groupcall.ts 群通话房间与信令中转
  src/avatars.ts   加密头像（按聊天分发的签名密钥信封）
  src/account.ts   注销账号
  src/social.ts    个人加密库（备注、收藏、贴纸、聊天列表、设置）、屏蔽、隐私
  src/realtime.ts  WebSocket（推送、输入中、在线状态）
  scripts/         init / allow-ip 命令行
  test/            接口测试
web/      React + Vite
  src/crypto/core.ts   端到端加密核心（libsodium），前端与测试共用
  src/crypto/keystore.ts  本地私钥存储（IndexedDB + 不可导出的 WebCrypto 包装密钥）
  src/lib/store.ts     状态、加解密流程、实时事件
  src/lib/files.ts     附件准备（缩略图、去 EXIF）、加密上传、下载解密、录音
  src/lib/localcache.ts 本机加密消息缓存（搜索、离线）
  src/lib/notify.ts    推送订阅、本地通知
  src/lib/chatlist.ts  置顶 / 归档 / 分组（加密同步）
  src/lib/groupcall.ts 群通话（mesh WebRTC）
  src/lib/avatars.ts   加密头像
  src/lib/backup.ts    个人数据备份 / 恢复
  src/lib/resume.ts    大文件断点续传
  public/sw.js         Service Worker（离线外壳、推送）
  src/components/MessageParts.tsx  安全 Markdown、附件气泡、表情回应
  src/pages/           登录/注册、会话列表、聊天窗口、聊天信息、设置、管理后台
deploy/   docker-compose + Caddy（另一种部署方式；生产环境用宝塔，见运维手册）
ops/      生产运维脚本：update / backup / offsite / status / reset-2fa / install-coturn …
```

## 许可证

[GNU AGPL-3.0](LICENSE)。修改后用来对外提供服务，需要按 AGPL 公开修改后的源代码。

## 安全问题

发现安全问题请不要公开提 issue，请通过 GitHub 的「Security → Report a vulnerability」私下报告。
