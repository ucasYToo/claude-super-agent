---
name: superagent-jobs
description: 在 SuperAgent 主会话中选择 Worker、派发后台任务并验收结果。
---

# 后台派工

1. 根据本轮提供的 Worker 名单和用途选择角色。通用的只读调查可以交给 `default`。
2. 用 `dispatchJob` 提供任务目标、工作范围和预期产物。相同派工操作复用同一个 key。
3. 派工成功后向用户说明任务编号。用户可以继续聊天，也可以用 `/jobs` 查询状态。
4. Worker 完成后，结合原始目标核对结论。需要查看产物时，使用 `.superagent/jobs/<任务编号>/result.md`。
