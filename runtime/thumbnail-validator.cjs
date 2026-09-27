"use strict";
// One image in a fresh process: no application imports or other Sharp consumers.
const sharp = require("sharp");
const MAX_BYTES = 2 * 1024 * 1024;
async function validate(bytes) {
  if (bytes.length < 4 || bytes.length > MAX_BYTES || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  let warned = false;
  const decoder = () => sharp(bytes, { failOn: "warning", limitInputPixels: 800 ** 2 })
    .timeout({ seconds: 3 }).on("warning", () => { warned = true; });
  try {
    const meta = await decoder().metadata();
    if (warned || meta.format !== "jpeg" || !meta.width || !meta.height || meta.width > 800 || meta.height > 800 || (meta.pages ?? 1) !== 1) return false;
    // Force all bounded pixels to decode. A resolved decode with warnings is NOT valid.
    await decoder().raw().toBuffer();
    return !warned;
  } catch { return false; }
}
module.exports = { validate };
if (require.main === module) {
  let size = 0;
  let chunks = [];
  let finished = false;
  const finish = (valid) => {
    if (finished) return;
    finished = true;
    chunks = [];
    process.stdin.pause();
    process.stdout.write(valid ? "cubby-thumbnail-v1:valid\n" : "cubby-thumbnail-v1:invalid\n", () => process.exit(0));
  };
  process.stdin.on("error", () => finish(false));
  process.stdin.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES) finish(false);
    else if (!finished) chunks.push(chunk);
  });
  process.stdin.on("end", async () => {
    if (!finished) finish(await validate(Buffer.concat(chunks, size)));
  });
}
