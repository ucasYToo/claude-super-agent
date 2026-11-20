# Claude Super Agent

在开发机上运行的个人助手。主会话接收 Web 或飞书消息，把耗时工作派给独立的 Claude Code Worker。派工后可以继续聊天，完成结果回到发起会话。工作台包含 Worker、定时任务与审批、Webhook、人格与记忆整理、图片输入和消息检索。

## 独立运行

需要 macOS 或 Linux、Node.js 22.16 或更高版本、Git，以及已登录的 Claude Code CLI。

```sh
npm install --global claude-super-agent
claude-super-agent init --workspace /absolute/path/to/project
claude-super-agent start --open
```

默认地址为 `http://127.0.0.1:4310/`。用 `status --json` 检查服务、投递队列和机器人状态，用 `stop` 结束服务。可选全局参数 `--data-dir <目录>` 指定独立的数据目录。前台调试用 `start --foreground --verbose`。

在「飞书 → 飞书机器人」填写应用凭据和工作区，授权名单可留空。用户私聊机器人发「你好」，就会收到自己在此应用下的 `open_id`。管理员将该 ID 填入「授权 open_id」并保存，用户再发 `/help` 即可验证。密钥可以保存到本机私有配置，也可以填写环境变量名；使用环境变量时请在启动服务前设置。开放平台启用机器人和长连接，订阅 `im.message.receive_v1`，开通单聊接收、消息发送、更新卡片和读取消息资源所需权限，然后发布对测试用户可见的应用版本。[飞书长连接](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-) · [飞书消息接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)

已授权用户私聊时，机器人立即在原消息上添加飞书的 `Typing` 表情，本轮处理结束后撤下。应用需具备消息表情写入权限，例如 `im:message.reactions:write_only`。[飞书表情回应接口](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create)

文字和图片可以分别选择模型。「工作区 → 图片模型」对应工作区的 `visionModel`，留空时沿用主模型。图片需要上游模型支持视觉输入。

默认 Worker 支持只读检索。在 Worker 页给需要写代码的角色配置工作目录和工具，例如 `Read,Glob,Grep,Edit,Write`。工作区允许的其他目录写在 `config.json` 的 `workspaces[].allowedCwds`。启用 Bash 的 Worker 拥有当前系统用户权限。

## 工作区初始文件

执行 `init` 后即可打开以下文件。在控制台添加工作区、通过 SDK 启动静态工作区、或在 llm-proxy 启用 SuperAgent 机器人时，也会自动补齐。再次初始化只创建缺失项，已有文件（包括空文件）和符号链接都会保留。

| 位置 | 用途 |
|---|---|
| `CLAUDE.md` | Claude Code 在此目录工作时使用的项目规则 |
| `SOUL.md` | 所有使用此目录的人共用的默认人格和约定 |
| `memory/MEMORY.md`、`memory/core/profile.md` | 记忆索引和基础资料，主会话每轮加载 |
| `memory/notes/topics.md`、`memory/journal/` | 按需读取的主题笔记和按月存放日志的目录 |
| `.claude/skills/superagent-jobs/SKILL.md` | 主助手派工和验收的操作说明 |
| `.superagent/jobs/WORKERS.md` | 内置 Worker 和任务产物说明。启用工作区后自动同步角色与用途 |

直接编辑工作区内的文件可调整公共默认值。控制台「记忆」、对话中保存的人格和自动整理的结果属于当前用户，保存在数据目录中。同名个人文件优先，旧版本保存的偏好继续生效。要给既有服务接入另外一个目录，可在「工作区 → 添加工作区」添加并保存。

## 工作台

顶部可选择工作区与会话。运行概览显示当前模型、排队数、后台任务以及运行中的 Claude 进程。点开任务的「执行详情」可查看时间、目录、执行事件和结果。「后台 Worker」按角色显示正在执行、排队和最近结束的任务。定时任务支持分别编辑和审批，在同页可追踪临时任务的接力与续跑。

「飞书」页显示连接状态。独立模式可编辑或停用单个机器人，两个运行模式均可选择已授权的 open_id 发送测试私聊。嵌入模式的凭据和授权名单由宿主 Remote Bridge 管理。

「核心记忆」按目录浏览文件，可只读查看项目规则、编辑当前用户的记忆，并查看上次整理的时间、结果及差异。「工作区」支持浏览服务端目录、填写自定义模型 ID、恢复默认模型及保存运行选项。主会话和 Worker 可设置 `--effort`、`--fallback-model`、`--max-budget-usd`，各占一行。独立模式还可以设置本机 Claude CLI 命令。每轮使用独立 CLI 进程，通过会话 ID 续接上下文，运行结束即释放进程。

## 日常操作

| 入口 | 用法 |
|---|---|
| 对话 | 发文字、图片或图文。飞书私聊先建立会话，在 Web 页顶部选择它就能查看同一上下文。Web 发起的对话回复可在工作台查看 |
| 后台任务 | `/jobs` 查看、`/cancel 编号` 取消。让助手「接着任务 #编号 继续」可以续跑已结束且有 Claude session ID 的任务 |
| 会话控制 | `/stop` 中断本轮，`/restart` 恢复主会话，`/new` 新开一代会话 |
| 定时任务 | 支持每天、工作日、每周、自定义五段 cron、一次性任务。对话中创建的任务通过 `/approve 编号` 或 `/reject 编号` 处理。命令行用 `task --help` |
| Webhook | 在目标会话的 Webhook 页创建和复制地址，支持 GET、POST 和请求头 `Idempotency-Key`。无 `msg` 执行预设指令，有 `msg` 时在无工具的独立轮次总结材料。地址可停用或轮换 |
| 记忆 | 在记忆页编辑 `SOUL.md`、索引、核心资料和主题笔记，立即整理或查看上次改动。夜间整理默认按工作区时区 03:00，工作区页可更改或关闭 |
| 远程访问 | `start --host 0.0.0.0` 后用 `token` 取得本机令牌，浏览器通过 `/?token=...` 换取 Cookie，脚本使用 Bearer。账户模式用 `user add <name>` 设置密码，再以 `start --auth` 启动。控制台账户均为受信管理员 |

## 集成到 llm-proxy

宿主把同一份 npm tarball 安装为依赖，在 Remote Bridge 的机器人设置中选择 **SuperAgent**，填写允许的工作目录并保存。用户私聊取得自己的 `open_id` 后，由管理员填入该机器人的「允许飞书用户」并保存。点「打开助手工作台」。工作台挂载在宿主的 `/superagent/`，进度更新和最终文本沿用该机器人的客户端。每个机器人独立选择处理器。

普通 Node.js 宿主也可以通过包根导入。下面的 `workspace` 是已授权的本机目录；业务代码可以替换 `deliver` 以接入自己的消息出口。

```js
const { createSuperAgent, localRoute } = require("claude-super-agent");

async function startAssistant(dataDir, workspace) {
  const agent = createSuperAgent({
    dataDir,
    workspaces: [{ id: "project", cwd: workspace }],
  });
  await agent.start();
  const route = localRoute("project");
  const receipt = await agent.handleMessage({
    ...route,
    messageId: "first-message",
    text: "请总结这个项目的用途",
  });
  return { agent, route, receipt };
}
```

`handleMessage` 在持久化后返回。通过 `agent.history(route.scope)`、`agent.listJobs(route.scope)` 和 `agent.onEvent(listener)` 观察结果，应用退出时 `await agent.stop()`。宿主有自己的飞书连接时，使用导出的 `acceptFeishu`、`sendFeishu` 和 `createConsoleRouter`。SDK 入口及数据结构见[技术方案](./docs/design.md)，自动化、Chrome 和真机验收见[自测手册](./docs/self-test.md)。

