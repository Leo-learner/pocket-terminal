# 本地验证

2026-09-16：Node22.22.2、macOS27 arm64、tmux3.6b。

- npm run check、npm run build通过。
- 13项自动测试通过：真实PTY命令、中文与emoji、resize/clamp、独立tmux配置、输入大小、会话恢复、运行中的后台作业、会话限制/名字注入隔离、输出背压、scrypt及权限、HTTP/Origin、WebSocket单次票据、退出与到期断开。
- 内置浏览器390×844：登录、新建真实会话、中文命令、刷新保持变量RECONNECTED:kept、历史输出、调整字号、真实stty尺寸读取；1280×800桌面布局通过。
- 设计对照：本地view_image检查mobile-concept.png，浏览器直接查看渲染截图；核对暗色画布、紧凑顶栏、会话页签、全高终端、两行快捷键和底部操作。实际输出由用户Shell决定，附加键盘按钮属于功能必需差异。浏览器截图API没有本地文件保存接口，因此截图直接在工具中对照，未伪造文件或声称对渲染截图执行view_image。
- 尚无iPhone真机输入法/锁屏/蜂窝切换验证。
