import type { ImageInput } from "../agent/contracts";

export const imageLimit = 5 * 1024 * 1024;

export function imageInput(data: Buffer): ImageInput {
  if (data.length > imageLimit || !data.length) {
    throw Error("图片需要在 5 MB 以内");
  }
  let type: ImageInput["type"];
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    type = "image/png";
  } else if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    type = "image/jpeg";
  } else if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) {
    type = "image/gif";
  } else if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    type = "image/webp";
  } else {
    throw Error("支持 PNG、JPEG、GIF 和 WebP 图片");
  }
  return { data, type };
}
