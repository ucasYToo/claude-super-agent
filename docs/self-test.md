# 自测手册

在仓库根目录运行下列命令。需要 Node.js 22.16 或以上、Git 和本机 Chrome。浏览器不在默认位置时，将 `CHROME_PATH` 设为可执行文件路径。自动化在各自的临时目录中创建数据库、工作区、Git 历史和机器人配置，模型进程和飞书网络有本地替身。

## 开发时验证

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run test:browser
```

| 从哪里验证 | 可观察的通过条件 |
|---|---|
| 工作区初始化 | CLI 在启动前生成全部模板。再次执行可恢复缺失文件且保留自定义内容、空文件与符号链接。在控制台保存第二个工作区即生成文件。SDK 能读取旧版个人记忆以及磁盘上修改的共享资料。宿主冒烟在任何聊天之前检查模板。 |
| 会话与 Worker | 同一个消息 ID 只派一次工，Worker 执行期间主会话能回答下一条消息，完成后主会话验收。覆盖并发上限、排队、取消、超时、续跑和三层接力。 |
| 异常退出与升级 | 强制终止真实 CLI 服务后，原 Worker 子进程退出。用原数据目录重启，进行中的任务记为中断。打开旧版 SQLite 时仍能查到历史任务。 |
| 飞书适配器 | 同一入站事件重复送达、两个机器人收到相同 ID、未授权用户、群聊、图文一起到达分别有断言。已授权消息在图片下载和模型执行前添加 Typing 表情，结束后仅移除对应表情。重复事件、慢回执和缺少表情权限均有断言。卡片更新复用首条消息 ID，重试复用投递 ID，最终文本回原聊天。 |
| 定时任务和 Webhook | 对话提议先审批。错过的周期跳过，过期的单次任务只执行一次。Webhook 覆盖轮换、停用、限流和重投，外部材料以无工具、独立会话运行。 |
| 人格、记忆与图片 | 整理成功能查询 Git 差异，生成错误时保留原文件。夜间整理期间发来的消息会排队。图片测试核对传入 Claude CLI 的 MIME 和原始字节摘要，检查图片模型选择。 |
| 访问控制 | 远程匿名请求与跨站写入被拒绝。账户登录后能读取状态，修改密码使原 Cookie 失效，连续失败登录触发限流。 |
| 浏览器 | Chrome 发送消息并收到回答，保存 Worker，创建定时任务和 Webhook，保存记忆，检索消息，打开设置。编辑已建计划，查看只读 CLAUDE.md，切换上级规则，浏览目录，向模拟机器人授权账号发送测试消息。在 375 像素视口逐页检查横向溢出，并检查页面运行错误。 |

单独排查可先运行 `npm run build`，再运行对应文件，例如 `node --test test/features/recovery.test.cjs`。测试文件按 `agent/`、`channels/`、`features/`、`server/`、`workspaces/` 分组。

## 验证同一安装包的两种用法

下面的命令适用于两个仓库相邻的检出目录。宿主使用 `vendor/` 中的 npm 包作为依赖，发布候选附带对应的锁文件。重新打包改过的源码后，先更新宿主依赖和锁文件。

```sh
mkdir -p artifacts
npm pack --pack-destination artifacts
archive="$PWD/artifacts/claude-super-agent-0.2.0.tgz"
cp "$archive" ../llm-proxy/vendor/
(cd ../llm-proxy && npm install --package-lock-only ./vendor/claude-super-agent-0.2.0.tgz)
(cd ../llm-proxy && npm ci && npm run build && npm test -- --runInBand)
npm run test:package -- "$archive" ../llm-proxy
```

`test:package` 在空 npm 项目安装归档，以消费方身份编译 TypeScript 示例，从已安装包启动 CLI，运行引擎、浏览器和异常退出测试。提供宿主目录时，脚本逐文件比对两个消费者装入的包，再经宿主已编译的飞书事件回调派工、继续聊天、验收结果并重载连接。第二个机器人走普通 Bridge。成功时打印归档的 SHA-256。只验证独立安装时可省略最后的宿主目录参数。

## 用真实 Claude 和飞书复验

1. 准备一个专用测试目录，在 README 中写入随机验收词。用自己的交互式 Claude CLI 确认当前模型能读取该文件。安装上面的归档，用 `claude-super-agent --data-dir /tmp/my-agent-check init --workspace /绝对路径` 初始化，再以相同数据目录执行 `start --foreground`。
2. 先在 Web 中发「派给默认 Worker，读取 README 并告诉我验收词和文件位置」，收到任务号后继续提问。核对任务页状态、最终结论和项目内的 `.superagent/jobs/<编号>/result.md`。记忆页可保存一句偏好，再执行整理并查看差异。
3. 飞书自建应用启用机器人和长连接，订阅 `im.message.receive_v1`，开通单聊收发和消息资源权限，发布到测试用户。在助手「飞书」页填写机器人和工作区，先留空授权名单。用测试账号私聊机器人，核对回复含自己的 open_id 和后台填写说明；此时不应产生模型轮次。将该 ID 加入授权名单，保存后发 `/help`。凭据可从环境变量读取。[飞书长连接配置](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)
4. 在指定私聊重复派工，核对任务号、进度卡和原聊天里的最终结论，再派一个任务并发送 `/cancel 编号`。发一张带明显颜色或文字的图片，核对回答与图片内容。需要指定视觉模型时，在「工作区 → 图片模型」填写当前账户可调用的模型。
5. 停止使用同一个 App ID 的独立连接。在宿主 Dashboard 的 Remote Bridge 里选择 SuperAgent 处理器、授权用户和工作目录。打开助手工作台，再从同一测试私聊重复第 4 步。用另一个普通 Bridge 机器人发一条消息，确认它仍由原处理器应答。
6. 测试结束后停止临时服务。记录归档哈希、Node 和 Claude 版本、任务号与机器人标识即可复查。真实飞书权限和模型图像识别需分别由指定租户、指定模型验证。
