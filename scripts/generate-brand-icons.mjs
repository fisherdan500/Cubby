import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const iconDirectory = path.join(root, "public", "icons");
const standardSource = path.join(root, "public", "icon.svg");
const maskableSource = path.join(root, "public", "brand", "cubby-maskable.svg");

await mkdir(iconDirectory, { recursive: true });

const outputs = [
  { source: standardSource, file: "favicon-32.png", size: 32 },
  { source: standardSource, file: "apple-touch-icon.png", size: 180 },
  { source: standardSource, file: "icon-192.png", size: 192 },
  { source: standardSource, file: "icon-512.png", size: 512 },
  { source: maskableSource, file: "icon-maskable-512.png", size: 512 }
];

for (const output of outputs) {
  const destination = path.join(iconDirectory, output.file);
  await sharp(output.source, { density: 512 })
    .resize(output.size, output.size, { fit: "fill" })
    .png({ compressionLevel: 9, palette: true })
    .toFile(destination);
  const metadata = await sharp(destination).metadata();
  if (metadata.format !== "png" || metadata.width !== output.size || metadata.height !== output.size) {
    throw new Error(`Invalid generated icon: ${output.file}`);
  }
}

console.info(`Generated ${outputs.length} Cubby icon assets in public/icons.`);
