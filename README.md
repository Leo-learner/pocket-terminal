# Pocket Terminal

面向 iPhone Safari / 主屏幕应用的私人 Mac 远程终端。真实 zsh、独立 tmux 会话、断线恢复、中文长文本输入、终端快捷键、会话历史与字号设置。最多保留12个会话，历史上限50000行，历史面板读取最近2000行且最多256KiB。

## 架构

手机 HTTPS → VPS Nginx 静态网站 / 鉴权 API 反向代理 → 仅绑定回环的 SSH 反向隧道 → Mac Node22服务 → node-pty → 独立 `tmux -L pocket-terminal` → zsh登录Shell。

网页只在服务收到输入时执行，不缓存离线按键、不重放断线输入。浏览器或Node进程断开不会结束tmux中的命令。Mac重启、关机或手动结束会话则会结束其中进程；睡眠期间不能远程操作，唤醒后隧道自动重连。电脑端可用 `tmux -L pocket-terminal list-sessions` 和 `tmux -L pocket-terminal attach -t <id>` 进入同一会话。

## 本地

需要 macOS、Node22+、tmux（已在本机安装）。

```sh
npm ci
npm run check
npm test
npm run build
node scripts/setup.mjs
npm start
```

浏览器访问 `http://localhost:4321`。首次生成的登录密钥只保存在 `.runtime/access-key.txt`（权限600），鉴权文件仅保存scrypt派生值。密钥、隧道私钥和日志均被Git排除。`setup`不会覆盖既有凭据。

生产设置：`POCKET_ORIGIN=https://terminal.dkz12345.com`、`POCKET_TRUST_PROXY=true`，服务仍只绑定127.0.0.1。仅在可信Nginx覆盖转发头时启用代理信任。

## 使用

1. 用私人登录密钥登录，点加号新建持久会话。
2. 点终端或键盘按钮直接输入；“输入”适合中文、语音输入及长命令。“发送文本”不补回车，“发送并回车”提交输入。
3. Esc、Tab、Ctrl、Alt和方向键位于底部；Ctrl/Alt为单次修饰键。Ctrl+C中断前台程序。
4. “复制”打开Mac中该会话保留的历史，可选择并复制；设置中调整字号或重命名。
5. 会话管理中的删除会结束会话及其所有程序，界面要求确认；关闭网页只会断开显示连接。
6. iPhone Safari 分享菜单 → 添加到主屏幕。系统可能挂起后台网页，回前台重新附着原会话。

## 发布与常驻

先完成本地typecheck、tests、build与依赖审计，再推送提交到私有GitHub仓库，最后把该提交的源码归档和本地构建产物部署到 `/opt/apps/pocket-terminal/releases/<commit>`。Nginx仅发布dist，API与WebSocket通过127.0.0.1:43210隧道转发。

`deploy/install-server.sh <release-dir> <public-key-file>` 只配置独立站点与受限的pocket-tunnel账号。每次更新前备份已有站点、发布指针和隧道公钥；验证nginx配置后reload。HTTPS证书使用Certbot，系统定时器负责续期。

`node scripts/install-mac.mjs` 生成专用隧道密钥与LaunchAgent草案；`--install`安装当前用户登录启动项。进程以Leo普通用户运行，SSH严格验证已经信任的服务器主机密钥。

停止远程访问：卸载两个 `com.leo.pocket-terminal` / `com.leo.pocket-terminal-tunnel` LaunchAgent，或停止对应服务。保留tmux会话；必须显式结束会话才终止其中进程。

## 安全与验证边界

HTTPS、scrypt高熵登录密钥、HttpOnly/Secure/SameSite=Strict/__Host- Cookie、精确Origin校验、单次短期WebSocket票据、12小时登录上限、速率限制、有限输出缓冲和背压。退出登录/凭据过期会关闭该登录的WebSocket。不记录终端内容或按键；全部前端依赖自托管，无外部脚本。

本地自动测试和内置浏览器验证覆盖真实命令、中文、尺寸与恢复。iPhone真机的拼音候选、系统剪贴板授权、长时间锁屏、Wi-Fi/蜂窝切换需要实际设备验收；不宣称网页能在后台永久不断线，也不宣称关机后进程继续运行。
