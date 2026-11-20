const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { sdk, fixture, until } = require("../support/harness.cjs");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgYERp7sAAAAASUVORK5CYII=",
  "base64",
);

function bot(id) {
  return { id, workspaceId: "demo", appId: "app-" + id, allowedOpenIds: ["owner"] };
}

function message(id, type, content) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "owner" } },
    message: {
      message_type: type,
      chat_type: "p2p",
      message_id: id,
      chat_id: "chat-" + id,
      content: JSON.stringify(content),
    },
  };
}

function client(bytes = png) {
  const sent = [];
  const patches = [];
  return {
    sent,
    patches,
    im: {
      message: {
        create: async (args) => {
          sent.push(args);
          return { code: 0, data: { message_id: "card-or-text-" + sent.length } };
        },
      },
      v1: {
        message: {
          patch: async (args) => {
            patches.push(args);
            return { code: 0 };
          },
        },
      },
      messageResource: { get: async () => ({ getReadableStream: () => Readable.from([bytes]) }) },
    },
  };
}

test("two bots, redelivery, image plus caption and fail-closed sender checks", async (t) => {
  const f = await fixture(t);
  const transport = client();
  const event = message("same", "post", {
    content: [
      [
        { tag: "text", text: "caption" },
        { tag: "img", image_key: "image-key" },
      ],
    ],
  });
  await sdk.acceptFeishu(f.agent, bot("one"), transport, event);
  await sdk.acceptFeishu(f.agent, bot("one"), transport, event);
  await sdk.acceptFeishu(f.agent, bot("two"), transport, event);
  await until(() => f.deliveries.length === 2);
  assert.deepEqual(f.deliveries.map((v) => v.route.target.botId).sort(), ["one", "two"]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].image.data, png);
  assert.ok(
    f.agent
      .history({ workspaceId: "demo", ownerId: "app-one:owner" })
      .some((r) => r.text.includes("[图片]")),
  );
  event.sender.sender_id.open_id = "stranger";
  await sdk.acceptFeishu(f.agent, bot("one"), transport, event);
  event.sender.sender_id.open_id = "owner";
  event.message.chat_type = "group";
  await sdk.acceptFeishu(f.agent, bot("one"), transport, event);
  assert.equal(f.calls.length, 2);
  assert.throws(() => sdk.imageInput(Buffer.alloc(5 * 1024 * 1024 + 1)));
  assert.throws(() => sdk.imageInput(Buffer.from("not an image")));
  const bad = client(Buffer.from("invalid"));
  await sdk.acceptFeishu(f.agent, bot("one"), bad, message("bad", "image", { image_key: "bad" }));
  assert.equal(bad.sent.length, 1);
  assert.equal(f.calls.length, 2);
});

test("patched cards and final texts use the original chat and stable delivery ID", async () => {
  const transport = client();
  const route = { target: { kind: "feishu", chatId: "original", appId: "a", botId: "b" } };
  const first = await sdk.sendFeishu(transport, {
    id: "stable",
    kind: "card",
    route,
    text: "start",
  });
  await sdk.sendFeishu(transport, {
    id: "patch",
    kind: "card",
    route,
    text: "running",
    cardId: first,
  });
  await sdk.sendFeishu(transport, { id: "final", kind: "text", route, text: "result" });
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.patches[0].path.message_id, first);
  assert.equal(transport.sent[1].data.uuid, "final");
  assert.equal(transport.sent[1].data.receive_id, "original");
});

test("delivery retry after restart uses the same id and does not re-run Claude", async (t) => {
  let fail = true;
  const f = await fixture(t, {
    deliver: async (item) => {
      if (fail) {
        throw Error("ack lost");
      }
      return item.id;
    },
  });
  const route = {
    ...f.route,
    target: { kind: "feishu", botId: "test", appId: "app", chatId: "chat" },
  };
  await f.send("hello", "msg", route);
  await until(() => f.deliveries.length === 1);
  await f.agent.stop();
  f.advance(2000);
  fail = false;
  await f.agent.start();
  await until(() => f.deliveries.length === 2);
  assert.equal(f.deliveries[0].id, f.deliveries[1].id);
  assert.equal(f.calls.length, 1);
});

test("unapproved users get only their own open_id in their private chat", async () => {
  const transport = client();
  const app = { ...bot("sample"), allowedOpenIds: [] };
  const event = message("identify", "image", { image_key: "private-image" });
  event.sender.sender_id.open_id = "ou_requester";
  transport.im.messageResource.get = assert.fail;
  transport.im.messageReaction = { create: assert.fail, delete: assert.fail };
  const agent = { handleMessage: assert.fail };

  await sdk.acceptFeishu(agent, app, transport, event);
  await sdk.acceptFeishu(agent, app, transport, event);
  const [first, retry] = transport.sent;
  assert.equal(first.data.receive_id, event.message.chat_id);
  assert.equal(first.data.msg_type, "text");
  assert.equal(first.data.uuid, retry.data.uuid);
  assert.match(JSON.parse(first.data.content).text, /open_id 是：\nou_requester\n/);
  assert.match(first.data.content, /授权名单/);
  assert.deepEqual(app.allowedOpenIds, []);

  event.message.chat_type = "group";
  await sdk.acceptFeishu(agent, app, transport, event);
  event.message.chat_type = "p2p";
  event.sender.sender_type = "app";
  await sdk.acceptFeishu(agent, app, transport, event);
  assert.equal(transport.sent.length, 2);
});

test("working reaction is immediate, scoped to the original message and removed at turn end", async (t) => {
  const f = await fixture(t);
  const api = client();
  const added = [];
  const removed = [];
  let finishTurn;
  f.setResponder(
    () =>
      new Promise((resolve) => {
        finishTurn = resolve;
      }),
  );
  let releaseImage;
  api.im.messageResource.get = () =>
    new Promise((resolve) => {
      releaseImage = () => resolve({ getReadableStream: () => Readable.from([png]) });
    });
  api.im.messageReaction = {
    create: async (input) => {
      added.push(input);
      return { code: 0, data: { reaction_id: "reaction-1" } };
    },
    delete: async (input) => {
      removed.push(input);
      return { code: 0 };
    },
  };
  const event = message("original", "image", { image_key: "file" });
  const send = () => sdk.acceptFeishu(f.agent, bot("one"), api, event);
  const first = send();
  const duplicate = send();
  assert.deepEqual(added, [
    { path: { message_id: "original" }, data: { reaction_type: { emoji_type: "Typing" } } },
  ]);
  assert.deepEqual(f.calls, []);
  releaseImage();
  assert.equal((await first).duplicate, false);
  assert.equal((await duplicate).duplicate, true);
  await until(() => finishTurn);
  assert.deepEqual(removed, []);
  finishTurn({ text: "Done" });
  await until(() => removed.length);
  assert.deepEqual(removed, [{ path: { message_id: "original", reaction_id: "reaction-1" } }]);
  await send();
  assert.equal(added.length, 1);
  assert.equal(f.calls.length, 1);
});

test("late reaction receipts, failed turns and reaction permission failures do not block replies", async (t) => {
  const f = await fixture(t);
  const api = client();
  let acknowledge;
  const removed = [];
  api.im.messageReaction = {
    create: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    delete: async (input) => {
      removed.push(input.path);
      return { code: 0 };
    },
  };
  f.setResponder(async () => {
    throw Error("model unavailable");
  });
  await sdk.acceptFeishu(f.agent, bot("one"), api, message("failed", "text", { text: "hello" }));
  await until(() => f.deliveries.some((item) => item.text.includes("model unavailable")));
  acknowledge({ data: { reaction_id: "late-receipt" } });
  await until(() => removed.length);
  assert.deepEqual(removed, [{ message_id: "failed", reaction_id: "late-receipt" }]);

  api.im.messageReaction.create = async () => {
    throw Error("permission denied");
  };
  f.setResponder(async () => ({ text: "still working" }));
  await sdk.acceptFeishu(
    f.agent,
    bot("one"),
    api,
    message("permission", "text", { text: "hello again" }),
  );
  await until(() => f.deliveries.some((item) => item.text === "still working"));
  assert.equal(removed.length, 1);
});

test("stopping the agent clears the markers for both running and queued messages", async (t) => {
  const f = await fixture(t, { respond: require("../support/harness.cjs").block });
  const api = client();
  const removed = [];
  api.im.messageReaction = {
    create: async ({ path }) => ({ data: { reaction_id: path.message_id } }),
    delete: async ({ path }) => {
      removed.push(path.message_id);
      return {};
    },
  };
  for (const id of ["running", "queued"]) {
    const event = message(id, "text", { text: id });
    event.message.chat_id = "same-chat";
    await sdk.acceptFeishu(f.agent, bot("one"), api, event);
  }
  await until(() => f.calls.length);
  await f.agent.stop();
  await until(() => removed.length === 2);
  assert.deepEqual(removed.sort(), ["queued", "running"]);
});
