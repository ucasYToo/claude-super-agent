# Claude Super Agent 开源版技术方案

**交付物是一个 npm 包，两种用法。** 个人用户通过 CLI 启动，在飞书私聊里使用助手。已有 `llm-proxy-view` 的用户按机器人启用同一套引擎，在原 Dashboard 看任务。首版必须用同一个 npm 安装包完成这两条链路。包名为 `claude-super-agent`。

## 1. 用户收到什么

用户发「派给 scout，读这个仓库，找出启动入口并给出处」。主会话确认范围，调度器写入任务后，用户收到任务号、Worker 和预计时间。此时可以继续问别的问题，也可以发 `/jobs` 或 `/cancel <任务号>`。Worker 完成后，主会话检查结论和产物，由原机器人发回原聊天。简单问题由主会话直接回答。

**统一发布范围。** 同一个版本交付调度核心、独立 CLI 与 Web 控制台、飞书双向收发和图片、宿主接入、定时任务与审批、人格与记忆整理、消息检索、Webhook。所有功能共用一份发布候选包、一套状态存储和同一次验收。

## 2. 包边界与运行方式

依赖方向为 `llm-proxy-view → claude-super-agent`。包根导出类型和 `createSuperAgent`，CLI 使用相同的工厂。导入包本身无副作用。第一版面向 macOS、Linux，要求 Node.js 22.16 及以上，本次实测为 macOS 上的 Node.js 22.23.1，TypeScript 编译为 CommonJS 并附声明，兼容宿主目前的构建。飞书 SDK 作为运行时依赖，SQLite 使用 Node 内置驱动，`claude` 由用户安装并完成认证。

| 部件 | 责任 |
|---|---|
| `agent/` 与 `workers/` | 消息归属、串行主会话、工具授权、Worker 调度、取消与恢复、事件和待发送消息 |
| `runtime/claude/` | 从标准输入传任务说明，按参数数组启动 `claude -p`，解析 `stream-json`，记录 session ID，处理超时和退出 |
| `storage` | 通过 Node 内置的 `node:sqlite` 写本地数据库，事务管理状态与待办事项，按版本迁移 |
| `channels/feishu/` | 归一化消息、检查机器人和发送人、发送文本、创建和更新卡片。独立入口在此管理连接 |
| `cli` | 配置、后台或前台启动、状态与任务控制，通过仅本机当前用户可访问的 Unix socket 调用运行中的引擎 |
| 宿主适配代码 | 留在 `llm-proxy`，复用已有机器人客户端、授权目录、服务启停、Dashboard 与 SSE |

主会话是可恢复的**逻辑会话**。首版每轮启动一次 CLI，保存返回的 session ID，下次按 ID 调用 `--resume`。同一逻辑会话一次执行一轮，每个 Worker 拥有独立 session ID。这样可以沿用宿主已使用的 CLI 行为，并分别中断主会话和 Worker。模型来自本地 Claude 配置或显式覆盖，开源包不绑定内部模型名。[Claude Code CLI 参数](https://code.claude.com/docs/en/cli-reference)

## 3. SDK 和两种接线方式

下列签名概括 v0.1 公共入口，类型以包内声明为准。宿主适配层先把认证过的发送者与允许访问的工作区解析成 `scope`。调度器把来源、权限范围和回复目标一起持久化。

```ts
type Scope = { workspaceId: string; ownerId: string };
type Target =
  | { kind: "feishu"; botId: string; appId: string; chatId: string }
  | { kind: "local"; clientId: string };

type Inbound = {
  scope: Scope;
  target: Target;
  conversationKey: string;
  messageId: string;
  text: string;
};

interface SuperAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleMessage(input: Inbound): Promise<{ turnId: number; duplicate: boolean }>;
  listJobs(scope: Scope): JobSummary[];
  cancelJob(scope: Scope, jobId: number): { id: number; state: string };
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
```

`handleMessage` 在入站事务提交后返回，随后异步执行。SDK 事件用于刷新界面。投递走独立的 `deliver(envelope)` 回调，包含稳定的投递 ID、类型、目标、文本或卡片内容和已有卡片 ID。回调返回渠道回执或带类别的错误，以便引擎安排重试。宿主首次加载、SSE 重连时从 `listJobs` 取快照。

**独立运行。** `claude-super-agent init` 写配置和工作区起始文件，配置工作区、机器人、主人和可选 Worker。`start` 后台运行，`start --foreground` 便于联调。App Secret 可由配置指定的环境变量提供。支持 `--data-dir`、`status --json`、`jobs list --json`、`jobs cancel <id>`、`stop`。独立模式用飞书官方 SDK 的 `WSClient` 和 `EventDispatcher` 接收 `im.message.receive_v1`，向原 `chat_id` 发送消息。[飞书 Node SDK](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)

最小 `config.json` 示例。把示例路径换成现有的绝对路径，把应用身份和主人 ID 换成测试应用的实际值。省略 Worker 模型时沿用主模型。

```json
{
  "workspaces": [
    {
      "id": "demo",
      "cwd": "/path/to/demo",
      "workers": [{ "name": "scout", "purpose": "只读检索代码并给出文件出处", "tools": ["Read", "Glob", "Grep"] }]
    }
  ],
  "feishu": {
    "bots": [
      {
        "id": "assistant",
        "workspaceId": "demo",
        "appId": "cli_example",
        "appSecretEnv": "FEISHU_APP_SECRET",
        "allowedOpenIds": ["ou_example"]
      }
    ]
  }
}
```

**嵌入运行。** 宿主将同一候选包保存为 `vendor/claude-super-agent-0.2.0.tgz`，用 `file:` 依赖安装并通过 npm 的 `bundleDependencies` 随宿主分发。宿主由服务创建一个引擎实例。以下示意里的路径解析、机器人查找和事件展示函数属于宿主。

```ts
import { createSuperAgent } from "claude-super-agent";

const agent = createSuperAgent({
  dataDir: hostAgentDataDir,
  resolveWorkspace: resolveAuthorizedWorkspace,
  deliver: sendWithExistingClient,
});
await agent.start();
const unsubscribe = agent.onEvent(forwardToDashboard);
// 飞书入口已完成授权，目标机器人已选用 SuperAgent。
await agent.handleMessage(normalizeInbound(event, bot));
// 宿主停止接收新输入后执行。
unsubscribe();
await agent.stop();
```

宿主配置在 `remoteBridge.feishu.bots[]` 上增加可选 `handler: "bridge" | "superagent"`，旧配置默认取 `bridge`。在 `src/remote/feishu.ts` 的入站处理处先按 bot 选处理器，再进入各自的命令解析。普通 Bridge 继续管理自己的会话、权限回复和文件返回；选 SuperAgent 的机器人使用自己的 `/jobs`、`/new` 等指令。校验失败或 SDK 入队失败只返回相应错误，同一事件只交给一个处理器。异步投递按持久化的 `botId + appId` 精确取客户端，机器人被删除或换绑时记录待处理状态。

宿主在启用机器人的连接就绪后启动共享引擎，首条事件也可按需启动。退出时停止入站并等待引擎释放资源。配置热重载复用同数据目录的活动引擎，关闭旧客户端后重建当前配置的连接。宿主在退出信号处理器中等待引擎停止。长连接由宿主调用 `WSClient.close()` 关闭。

Dashboard 通过宿主提供的 `GET /superagent/api/jobs`、`POST /superagent/api/jobs/:id/cancel` 和 SSE 展示与操作任务。沿用 Remote Bridge 的认证、同源检查和目录授权。服务器从已认证的上下文解析操作范围。嵌入方式使用宿主已有的 HTTP 端口和 WS 连接。

上线时先给一个测试机器人选择新处理器。回切时暂停该机器人的新派工，列出并完成或显式取消在途任务，处理待投递结果，再把 `handler` 调回 `bridge`。宿主保留原有会话记录；SuperAgent 的任务历史存放在自己的数据库。SDK 导出按语义化版本维护，宿主锁定已通过联调的版本。

## 4. 调度、进度与恢复

1. **收件。** 每个私聊按应用、聊天、发送人、工作区定位会话，`/new` 生成新会话代次。入站表对「渠道、应用身份、上游消息 ID」建唯一约束，同事务写主会话待办；重复回调返回原 `turnId`。本地客户端生成稳定的请求 ID。控制命令同样去重，`/stop`、`/cancel` 走控制通道，可打断正在执行的工作。
2. **派工。** 主会话通过受限的本地 MCP 工具 `dispatchJob` 提供标题、完整说明、Worker 名和 ETA。工具经本机 socket 回到运行中的调度器，使用当轮绑定的短期凭据，作用域和回复目标由引擎补全。每次派工携带该轮内稳定的操作 ID；事务校验容量、去重、保存配置快照并写派工回执。回执由引擎发一次，主会话输出不会再生成同一回执。Worker 不获得调度工具和控制凭据。
3. **运行。** 单实例默认最多 3 个 Worker 同时运行，另有 10 个排队名额，超出时明确回复队列已满。可运行任务按入队顺序启动。ETA 限 3–120 分钟，运行上限 180 分钟，均从开跑计时。默认 Worker 跟随主模型和工作区，每工作区最多配置 10 个 Worker；修改配置只影响后续派工。
4. **检查与验收。** 到 ETA 时把进度检查排入原主会话，只开放更新 ETA 或取消。完成后写产物和终态，同事务排入唯一的完成待办。主会话结合原目标验收、发结论，可接力到下一步。自动接力最多 3 层。显式续任务生成新任务号，沿用原 Worker、目录和可恢复的 session ID。原会话缺失时返回明确错误。
5. **取消与停机。** 状态从 `queued → running → succeeded | failed | timed_out | interrupted`，`queued` 和 `running` 均可到 `cancelled`。条件更新裁决取消与完成的竞争；取消成功后丢弃迟到的完成结果。结束一组子进程后才释放运行名额。用独立的子进程监督器监测父进程管道关闭，覆盖宿主异常退出；只有验证归属的进程组可被终止。
6. **重启。** 引擎对数据目录持独占运行锁。启动时保留 `queued` 顺序，将上次仍标为 `running` 的任务记为 `interrupted` 并通知原会话。已开始且结果未知的模型轮次同样标中断，已提交的派工保留，避免自动重复改文件。`/restart` 仅恢复主会话。`/new` 之后，旧任务仍向其保存的会话代次验收、向原聊天投递。切换工作区时，原工作区的活动任务中断、队列暂停，切回后恢复。

**飞书投递。** 同一任务创建一张进度卡并持久化卡片 ID；更新按卡片串行、合并频繁变化，结论以普通文本发送。入队回执、最终结论和分段长文本各有稳定投递 ID。先写待发送表，再调用渠道；飞书创建消息使用持久化的请求 `uuid`。暂时失败按退避重试；渠道适配器可传回重试时长。对于「服务端可能已收件、本机没有回执」，只在渠道去重有效期内自动重试，过期标为投递结果待核对。卡片失败仍可发送最终结论。宿主显示发送状态，发送故障不会触发新一轮模型执行。[飞书消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create)

## 5. 数据、配置与权限

| 位置 | 内容与约束 |
|---|---|
| 独立 `~/.claude-super-agent/`；嵌入默认 `~/.claude-proxy/superagent/` | 配置、运行锁、控制 socket、轮转日志、`agent.sqlite`。每个数据目录只由一个引擎调度。服务和测试均支持显式传目录 |
| SQLite | `settings`（工作区与 Worker 覆盖配置）、`sessions`、`resumes`、`turns`、`jobs`、`messages`、`outbox`、`schedules`、`hooks` 和迁移版本。保存当前模型会话 ID、父任务/续跑关系、原始回复路由、发送状态。新增迁移按序执行；迁移失败在开放入站前退出 |
| 工作区 | 初始化补齐缺失的规则、人格、记忆索引与子目录、派工 Skill 和 Worker 说明。模板与 npm 包一起分发。已有项目规则、空文件和符号链接保留。每项任务在专用产物目录 `.superagent/jobs/<id>/` 保存经过筛选的 `events.jsonl` 和 `result.md`，采用临时文件后原子重命名。保留最近 50 个已结束任务，未投递、待验收或仍被接力引用的记录延后清理 |

独立模式配置主人或明确的授权名单，启用助手的机器人只处理已授权用户的私聊。SuperAgent 允许先保存空名单。未授权用户私聊时只收到自己的应用级 open_id 和后台填写说明，经管理员保存后才能调用助手。群聊和机器人发来的消息跳过。机器人身份变更时重新校验用户映射。工作目录取自用户配置的允许列表，按真实路径检查；操作任务须匹配工作区和用户。默认仅开放完成当前任务所需的 Claude 工具，沿用明确授权的工作区范围。目录校验控制进程从哪里启动；开放任意 shell 的 Worker 仍拥有本机用户权限，强隔离部署需使用独立账户或容器。

App Secret、控制凭据只给需要它们的组件，子进程环境按用途构造。数据目录使用用户私有权限，日志保留状态、错误码和关联 ID。卡片、事件和日志仅取公开进度字段；聊天正文与任务结果作为用户本地数据单独管理。入站去重索引、未决出站回执按渠道重投期独立保留。开源仓库与 npm 包只收录面向公众重写的文档、示例与已确认可分发的代码。发布前核对许可证、包名权限、Git 待提交文件及 tarball 清单。

## 6. Web、定时、记忆、图片与 Webhook

| 能力 | 实现约定 |
|---|---|
| 独立 Web 与消息记录 | Web 与飞书可显式绑定同一主会话，回复目标随触发来源保存。按来源、时间和状态查询消息。默认监听回环地址，对外绑定需认证，写请求做同源和作用域检查 |
| 定时任务 | 工作区保存时区、cron 或单次时间和授权人。助手提议先待批准；以任务 ID 和计划触发时刻去重。上轮未完跳过，错过的周期任务跳过，过期的单次任务补跑一次 |
| 人格与记忆 | 主会话加载用户可编辑的 `SOUL.md` 和索引，按需读取主题笔记。夜间整理按工作区与用户串行执行，记录变更前版本，失败回滚，成功后新会话加载整理结果 |
| 图片 | 通过飞书消息资源接口下载，校验类型与大小后交给 Claude，仅在处理期间保留内容。图片模型优先取 `visionModel`，留空时使用主模型。文本消息和图片按飞书消息结构关联 |
| Webhook | 每个工作区独立凭据，可轮换、停用和限流。受信的预设指令与外部传入内容分字段；带外部内容的轮次只允许生成摘要，调度器拒绝工具副作用 |

项目入口为 `src/index.ts`。运行时位于 `src/agent/`，会话入队、单轮执行分别在 `inbox.ts` 和 `turn-executor.ts`。调度、自动化、记忆、飞书、Web 服务和 CLI 分别归入 `workers/`、`automation/`、`memory/`、`channels/feishu/`、`server/` 和 `cli/`。主会话先查个人文件，再从工作区的 `SOUL.md` 和 `memory/` 读取同名默认值。个人修改及整理产生的 Git 历史按工作区与用户分开，保存在数据目录的 `memory/<scope-hash>/` 中。

实施与发版的通过标准见[自测手册](./self-test.md)。


工作台通过同源 API 获取当前用户的任务、执行事件和整理状态。网页调试对话按选中的会话标识读取历史。宿主提供连接状态及测试投递回调，发测试消息前重新校验工作区、机器人和接收人。规则开关仅对主会话及 Worker 的 Claude 调用传入上级路径排除项。工作区与用户的全局规则可独立管理。[Claude Code 规则加载](https://code.claude.com/docs/en/memory#exclude-specific-claudemd-files)
