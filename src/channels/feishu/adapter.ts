import { createHash } from "node:crypto";

import * as lark from "@larksuiteoapi/node-sdk";

import { Bot, Delivery, ImageInput, Route } from "../../agent/contracts";
import { SuperAgent } from "../../agent/super-agent";
import { imageInput, imageLimit } from "../images";

import { markWorking, ReactionApi } from "./working-reaction";

interface Client {
  im: {
    messageReaction?: ReactionApi;
    message: {
      create(input: {
        params: { receive_id_type: "chat_id" };
        data: { receive_id: string; msg_type: string; content: string; uuid: string };
      }): Promise<{ code?: number; data?: { message_id?: string } }>;
    };
    v1: {
      message: {
        patch(input: {
          path: { message_id: string };
          data: { content: string };
        }): Promise<{ code?: number }>;
      };
    };
    messageResource: {
      get(input: {
        path: { message_id: string; file_key: string };
        params: { type: string };
      }): Promise<{ getReadableStream(): import("node:stream").Readable }>;
    };
  };
}

export async function sendFeishu(client: Client, item: Delivery) {
  const target = item.route.target;
  if (target.kind !== "feishu") {
    throw Error("无效的飞书目标");
  }
  const card = {
    config: { update_multi: true },
    elements: [{ tag: "div", text: { tag: "plain_text", content: item.text } }],
  };
  const content = JSON.stringify(item.kind === "card" ? card : { text: item.text });
  if (item.kind === "card" && item.cardId) {
    const response = await client.im.v1.message.patch({
      path: { message_id: item.cardId },
      data: { content },
    });
    if (response.code) {
      throw Error("飞书卡片更新失败 " + response.code);
    }
    return item.cardId;
  }
  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: target.chatId,
      msg_type: item.kind === "card" ? "interactive" : "text",
      content,
      uuid: item.id,
    },
  });
  if (response.code || !response.data?.message_id) {
    throw Error("飞书发送失败 " + (response.code || "缺少回执"));
  }
  return response.data.message_id;
}

export async function acceptFeishu(agent: SuperAgent, bot: Bot, client: Client, data: unknown) {
  const event = data as Record<string, any>;
  const message = event?.message;
  const sender = event?.sender;
  const id = sender?.sender_id?.open_id;
  if (
    !message ||
    message.chat_type !== "p2p" ||
    sender?.sender_type !== "user" ||
    typeof id !== "string" ||
    !id ||
    !message.chat_id ||
    !message.message_id
  ) {
    return;
  }
  const route: Route = {
    scope: { workspaceId: bot.workspaceId, ownerId: bot.appId + ":" + id },
    target: { kind: "feishu", botId: bot.id, appId: bot.appId, chatId: message.chat_id },
    conversationKey: message.chat_id,
  };
  if (!bot.allowedOpenIds?.includes(id)) {
    const receiptId = createHash("sha256")
      .update(bot.appId + ":" + message.message_id + ":unauthorized")
      .digest("hex")
      .slice(0, 32);
    await sendFeishu(client, {
      id: receiptId,
      route,
      kind: "text",
      text: [
        "你在这个机器人上的 open_id 是：",
        id,
        "请将这个 ID 交给管理员，填入后台此机器人的飞书用户授权名单。保存后，再发一条消息即可使用。",
      ].join("\n"),
    });
    return;
  }
  const previous = agent.receivedTurnId(route, message.message_id);
  if (previous !== undefined) return { turnId: previous, duplicate: true };

  // Image retrieval can yield before durable admission. Share that work on concurrent redelivery.
  const key = JSON.stringify([bot.appId, message.message_id]);
  let pending = admissions.get(agent);
  if (!pending) {
    pending = new Map();
    admissions.set(agent, pending);
  }
  const existing = pending.get(key);
  if (existing) {
    const receipt = await existing;
    return receipt && { ...receipt, duplicate: true };
  }
  const receipt = acceptAuthorized(agent, bot.appId, client, route, message);
  pending.set(key, receipt);
  try {
    return await receipt;
  } finally {
    pending.delete(key);
  }
}

type Receipt = Awaited<ReturnType<SuperAgent["handleMessage"]>>;
const admissions = new WeakMap<SuperAgent, Map<string, Promise<Receipt | undefined>>>();

async function acceptAuthorized(
  agent: SuperAgent,
  appId: string,
  client: Client,
  route: Route,
  message: { message_id: string; message_type: string; content: string },
) {
  const finish = client.im.messageReaction
    ? markWorking(client.im.messageReaction, message.message_id)
    : undefined;
  let text = "";
  let key = "";
  try {
    const content = JSON.parse(message.content);
    if (message.message_type === "text") {
      text = content.text || "";
    } else if (message.message_type === "image") {
      key = content.image_key;
    } else if (message.message_type === "post") {
      const post = content.content ? content : content.zh_cn || content.en_us;
      text = post?.title || "";
      for (const row of post?.content || []) {
        text +=
          "\n" +
          row
            .filter((c: any) => c.tag === "text" || c.tag === "a")
            .map((c: any) => c.text || "")
            .join("");
        for (const img of row.filter((part: { tag: string }) => part.tag === "img")) {
          if (key) {
            throw Error("每条消息支持一张图片");
          }
          key = img.image_key;
        }
      }
    } else {
      throw Error("请发送文字或图片");
    }
    let image: ImageInput | undefined;
    if (key) {
      const result = await client.im.messageResource.get({
        path: { message_id: message.message_id, file_key: key },
        params: { type: "image" },
      });
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = result.getReadableStream();
      for await (const chunk of stream) {
        const part = Buffer.from(chunk);
        total += part.length;
        if (total > imageLimit) {
          throw Error("图片需要在 5 MB 以内");
        }
        chunks.push(part);
      }
      image = imageInput(Buffer.concat(chunks));
    }
    return await agent.handleMessage(
      { ...route, messageId: message.message_id, text, image },
      finish,
    );
  } catch (e) {
    finish?.();
    const errorId = createHash("sha256")
      .update(appId + ":" + message.message_id + ":error")
      .digest("hex")
      .slice(0, 32);
    await sendFeishu(client, {
      id: errorId,
      route,
      kind: "text",
      text: "消息处理失败：" + (e as Error).message,
    });
  }
}

export async function sendFeishuTest(
  client: {
    im: {
      message: {
        create(input: {
          params: { receive_id_type: "open_id" };
          data: { receive_id: string; msg_type: string; content: string };
        }): Promise<{ code?: number }>;
      };
    };
  },
  openId: string,
) {
  const result = await client.im.message.create({
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: openId,
      msg_type: "text",
      content: JSON.stringify({ text: "Super Agent 飞书连接测试成功。" }),
    },
  });
  if (result.code) throw Error("飞书拒绝了测试消息：" + result.code);
}

export class FeishuConnections {
  private bots = new Map<string, { bot: Bot; client: lark.Client; ws: lark.WSClient }>();

  status() {
    return [...this.bots.values()].map(({ bot, ws }) => ({
      id: bot.id,
      state: ws.getConnectionStatus(),
    }));
  }

  async testMessage(workspaceId: string, botId: string, openId: string) {
    const live = this.bots.get(botId);
    if (
      !live ||
      live.bot.workspaceId !== workspaceId ||
      !live.bot.allowedOpenIds.includes(openId)
    ) {
      throw Error("请选择此工作区已启用的机器人及其已授权用户");
    }
    await sendFeishuTest(live.client, openId);
  }

  async deliver(item: Delivery) {
    const target = item.route.target;
    if (target.kind !== "feishu") {
      return;
    }
    const live = this.bots.get(target.botId);
    if (
      !live ||
      live.bot.appId !== target.appId ||
      !live.bot.allowedOpenIds.some((id) => item.route.scope.ownerId === target.appId + ":" + id)
    ) {
      throw Error("原机器人或用户授权已变更");
    }
    return sendFeishu(live.client, item);
  }

  configure(bots: Bot[], agent: SuperAgent) {
    const seen = new Set<string>();
    const apps = new Set<string>();
    const configs = bots.map((input) => {
      const bot = { ...input, allowedOpenIds: input.allowedOpenIds ?? [] };
      const secret = bot.appSecretEnv ? process.env[bot.appSecretEnv] : bot.appSecret;
      if (
        !bot.id ||
        seen.has(bot.id) ||
        !bot.appId ||
        apps.has(bot.appId) ||
        !secret ||
        !Array.isArray(bot.allowedOpenIds) ||
        bot.allowedOpenIds.some((id) => typeof id !== "string" || !id.trim())
      ) {
        throw Error("请检查机器人标识、应用凭据和授权名单格式");
      }
      agent.workspace(bot.workspaceId);
      seen.add(bot.id);
      apps.add(bot.appId);
      return { bot, secret };
    });
    this.close();
    for (const { bot, secret } of configs) {
      if (bot.enabled === false) continue;
      const opts = {
        appId: bot.appId,
        appSecret: secret,
        domain: lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.error,
      };
      const client = new lark.Client(opts);
      const ws = new lark.WSClient(opts);
      this.bots.set(bot.id, { bot, client, ws });
      const dispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => {
          if (this.bots.get(bot.id)?.ws === ws) {
            await acceptFeishu(agent, bot, client, data);
          }
        },
      });
      void ws
        .start({ eventDispatcher: dispatcher })
        .catch(() => console.error("飞书长连接启动失败", bot.id));
    }
  }

  close() {
    for (const { ws } of this.bots.values()) {
      ws.close();
    }
    this.bots.clear();
  }
}
