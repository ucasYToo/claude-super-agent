import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }

  if (!process.stdin.isTTY) {
    throw Error("从管道读取密码请加 --password-stdin");
  }
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stderr.write("密码：");
    const password = await input.question("");
    process.stderr.write("\n确认密码：");
    if (password !== (await input.question(""))) {
      throw Error("两次输入的密码不同");
    }
    return password;
  } finally {
    process.stderr.write("\n");
    input.close();
  }
}
