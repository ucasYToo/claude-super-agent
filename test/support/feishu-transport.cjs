// Preloaded only in the isolated CLI used by the browser smoke test.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = process.env.SUPERAGENT_TEST_PACKAGE || path.resolve(__dirname, "../..");
const fromPackage = createRequire(path.join(root, "package.json"));
const sdkPath = fromPackage.resolve("@larksuiteoapi/node-sdk");
const sdk = fromPackage(sdkPath);

class TestConnection {
  getConnectionStatus() {
    return { state: "connected" };
  }

  async start({ eventDispatcher }) {
    const file = path.join(process.env.FEISHU_TEST_DIR, "incoming.json");
    let last;
    this.timer = setInterval(async () => {
      if (!fs.existsSync(file)) return;
      const content = fs.readFileSync(file, "utf8");
      if (last === content) return;
      last = content;
      const event = JSON.parse(content);
      await eventDispatcher.invoke(
        {
          schema: "2.0",
          header: { event_type: "im.message.receive_v1" },
          event,
        },
        { needCheck: false },
      );
    }, 40);
  }

  close() {
    clearInterval(this.timer);
  }
}

class TestClient {
  im = {
    message: {
      create: async ({ data }) => {
        fs.appendFileSync(
          path.join(process.env.FEISHU_TEST_DIR, "sent.jsonl"),
          JSON.stringify(data) + "\n",
        );
        return { code: 0, data: { message_id: data.uuid } };
      },
    },
  };
}

require.cache[sdkPath].exports = { ...sdk, Client: TestClient, WSClient: TestConnection };
