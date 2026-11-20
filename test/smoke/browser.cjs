const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { until } = require("../support/harness.cjs");
const { chromium } = require("playwright-core");
const { startCli } = require("../support/cli-process.cjs");

async function main() {
  const cleanup = [];
  try {
    const transportDir = fs.mkdtempSync(path.join(os.tmpdir(), "csa-feishu-"));
    cleanup.push(() => fs.rmSync(transportDir, { recursive: true, force: true }));
    const cli = await startCli({ after: (fn) => cleanup.push(fn) }, [], {
      NODE_OPTIONS:
        "--require " + JSON.stringify(path.join(__dirname, "../support/feishu-transport.cjs")),
      FEISHU_TEST_DIR: transportDir,
    });
    const browser = await chromium.launch({
      channel: process.env.CHROME_PATH ? undefined : "chrome",
      executablePath: process.env.CHROME_PATH,
      headless: true,
    });
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(cli.base);
    const navigate = async (title) => {
      await page.getByRole("navigation").getByRole("button", { name: title, exact: true }).click();
      await page.getByRole("heading", { name: title, exact: true, level: 1 }).waitFor();
    };
    await page.getByLabel("消息", { exact: true }).fill("browser smoke");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("received browser smoke", { exact: true }).waitFor();
    await navigate("后台 Worker");
    await page.getByLabel("名称", { exact: true }).fill("scout");
    await page.getByLabel("用途", { exact: true }).fill("只读检索");
    await page.getByRole("button", { name: "保存 Worker" }).click();
    await page.getByRole("heading", { name: "scout" }).waitFor();
    await navigate("定时任务");
    await page.getByLabel("标题").fill("日报");
    await page.getByLabel("任务说明").fill("整理当天记录");
    await page.getByLabel("重复方式").selectOption("daily");
    await page.getByRole("button", { name: "添加定时任务" }).click();
    await page.getByRole("heading", { name: "日报" }).waitFor();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByLabel("标题").fill("工作日报");
    await page.getByRole("button", { name: "保存任务" }).click();
    await page.getByRole("heading", { name: "工作日报" }).waitFor();
    await page.getByRole("heading", { name: "临时任务" }).waitFor();
    await navigate("Webhook");
    await page.getByLabel("名称").fill("CI");
    await page.getByLabel("处理指令").fill("总结输入");
    await page.getByRole("button", { name: "创建 Webhook" }).click();
    await page.getByRole("heading", { name: "CI" }).waitFor();
    await navigate("核心记忆");
    await page.getByRole("button", { name: "CLAUDE.md", exact: true }).click();
    await until(() =>
      page
        .getByLabel("内容", { exact: true })
        .evaluate((el) => el.readOnly && el.value.includes("工作区")),
    );
    await page.getByLabel("忽略上级目录").check();
    await page.getByRole("button", { name: "SOUL.md", exact: true }).click();
    await until(() =>
      page
        .getByLabel("内容", { exact: true })
        .evaluate((el) => !el.readOnly && el.value.length > 0),
    );
    await page.getByLabel("内容", { exact: true }).fill("称呼我为测试用户");
    await page.getByRole("button", { name: "保存文件" }).click();
    await navigate("消息记录");
    await page.getByLabel("搜索文本").fill("browser smoke");
    await page.getByRole("button", { name: "查询" }).click();
    await page.getByText("received browser smoke", { exact: true }).waitFor();
    await navigate("工作区");
    await page.getByRole("button", { name: "浏览目录" }).click();
    await page.getByRole("button", { name: "选择此目录" }).click();
    assert.equal(
      await page.getByLabel("本机绝对路径").inputValue(),
      fs.realpathSync(cli.workspace),
    );
    await navigate("飞书");
    await page.getByRole("heading", { name: "飞书机器人" }).waitFor();
    await page.getByLabel("机器人标识", { exact: true }).fill("assistant");
    await page.getByLabel("App ID", { exact: true }).fill("cli_fixture");
    await page.getByLabel("App Secret", { exact: true }).fill("test-only");
    await page.getByRole("button", { name: "保存机器人" }).click();
    await page.getByRole("heading", { name: "assistant", exact: true }).waitFor();
    const send = (id, text) => {
      const event = {
        sender: { sender_type: "user", sender_id: { open_id: "ou_fixture" } },
        message: {
          message_type: "text",
          chat_type: "p2p",
          chat_id: "oc_fixture",
          message_id: id,
          content: JSON.stringify({ text }),
        },
      };
      const temp = path.join(transportDir, "writing");
      fs.writeFileSync(temp, JSON.stringify(event));
      fs.renameSync(temp, path.join(transportDir, "incoming.json"));
    };
    send("first", "你好");
    const replies = path.join(transportDir, "sent.jsonl");
    const first = await until(
      () => fs.existsSync(replies) && fs.readFileSync(replies, "utf8").trim(),
    );
    assert.match(JSON.parse(JSON.parse(first).content).text, /open_id 是：\nou_fixture\n/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cli.dataDir, "config.json"))).feishu.bots[0]
        .allowedOpenIds,
      [],
    );
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByLabel("授权 open_id（每行一个）").fill("ou_fixture");
    await page.getByRole("button", { name: "保存机器人" }).click();
    await until(() =>
      JSON.parse(
        fs.readFileSync(path.join(cli.dataDir, "config.json")),
      ).feishu.bots[0].allowedOpenIds.includes("ou_fixture"),
    );
    await page.getByRole("button", { name: "发送测试消息" }).click();
    await until(() => fs.readFileSync(replies, "utf8").includes("飞书连接测试成功"));
    cli.exec("stop");
    await until(() => !fs.existsSync(path.join(cli.dataDir, "runtime.json")));
    const restarted = cli.exec("start", "--port", "0");
    send("after-restart", "/help");
    await until(() =>
      fs.readFileSync(path.join(transportDir, "sent.jsonl"), "utf8").includes("/jobs"),
    );
    await page.goto(restarted + "#feishu");
    await page.getByRole("heading", { name: "飞书机器人" }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    for (const title of [
      "运行概览",
      "后台 Worker",
      "定时任务",
      "Webhook",
      "核心记忆",
      "消息记录",
      "工作区",
      "飞书",
    ]) {
      await navigate(title);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        title,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "Chrome passed: chat, workers, schedules, webhooks, memory, history, settings, Feishu self-ID reply and manual authorization, restart and mobile layout.",
    );
  } finally {
    for (const close of cleanup.reverse()) {
      await close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
