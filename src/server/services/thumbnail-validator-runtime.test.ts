import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { validFeedPhotoThumbnail } from "./feed-photo-processing";

it.each(["metadata", "pixels"])("rejects a resolved decode with a warning at %s", async (stage) => {
  const source = await readFile("runtime/thumbnail-validator.cjs", "utf8");
  const childModule = { exports: {} as { validate: (bytes: Buffer) => Promise<boolean> } };
  const fakeSharp = () => {
    let warning = () => {};
    const decoder = {
      timeout: () => decoder,
      on: (_event: string, listener: () => void) => { warning = listener; return decoder; },
      metadata: async () => { if (stage === "metadata") warning(); return { format: "jpeg", width: 16, height: 16 }; },
      raw: () => decoder,
      toBuffer: async () => { if (stage === "pixels") warning(); return Buffer.alloc(16); }
    };
    return decoder;
  };
  vm.runInNewContext(source, { require: () => fakeSharp, module: childModule, Buffer });
  await expect(childModule.exports.validate(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).resolves.toBe(false);
});

it("isolates repeated metadata-primed corrupt reads from concurrent parent Sharp consumers", async () => {
  const good = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).jpeg().toBuffer();
  const damaged = Buffer.concat([good.subarray(0, good.length - 5), good.subarray(-2)]);
  await sharp(damaged).metadata();
  for (let round = 0; round < 4; round++) {
    for (const [input, expected] of [[damaged, false], [good, true]] as const) {
      const readers = Array.from({ length: 8 }, () => sharp(good).stats());
      const result = await Promise.all([validFeedPhotoThumbnail(input), ...readers]);
      expect(result[0]).toBe(expected);
    }
  }
}, 15_000);

it("includes the fixed helper in standalone traces and the production image sources", async () => {
  const config = (await import(/* @vite-ignore */ pathToFileURL(path.resolve("next.config.mjs")).href)).default;
  expect(config.experimental.outputFileTracingIncludes["/*"] ?? []).toContain("./runtime/thumbnail-validator.cjs");
  const docker = await readFile("Dockerfile", "utf8");
  expect(docker).toContain("COPY --from=builder --chown=node:node /app/runtime/thumbnail-validator.cjs ./runtime/thumbnail-validator.cjs");
});
