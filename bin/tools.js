const readline = require("node:readline");
const http = require("node:http");
const rpc = async (method, params) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, params });
    const req = http.request(
      {
        socketPath: process.env.AGENT_SOCKET,
        path: "/",
        method: "POST",
        headers: {
          authorization: "Bearer " + process.env.AGENT_TURN_KEY,
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              throw Error(parsed.error);
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) {
    return;
  }
  const reply = { jsonrpc: "2.0", id: msg.id };
  try {
    if (msg.method === "initialize") {
      reply.result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "assistant", version: "0.1.0" },
      };
    } else if (msg.method === "ping") {
      reply.result = {};
    } else if (msg.method === "tools/list" || msg.method === "tools/call") {
      reply.result = await rpc(msg.method, msg.params);
    } else {
      reply.error = { code: -32601, message: "Unknown method" };
    }
  } catch (error) {
    reply.error = { code: -32000, message: error.message };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
});
