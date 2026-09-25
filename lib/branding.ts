import sharp from "sharp";
import pngToIco from "png-to-ico";
import { promises as fs } from "node:fs";
import path from "node:path";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons");

// Fixed asset paths — uploads overwrite these in place, so branding applies
// instantly with no rebuild (unlike app/*/icon routes, which bake at build).
export const BRAND_PATHS = {
  logo: path.join(PUBLIC_DIR, "official_logo.png"),
  background: path.join(PUBLIC_DIR, "bg.jpg"),
  favicon: path.join(PUBLIC_DIR, "favicon.ico"),
} as const;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function fail(msg: string): never {
  throw new Error(msg);
}

async function readImage(buf: Buffer): Promise<sharp.Sharp> {
  if (!buf?.length || buf.length > MAX_UPLOAD_BYTES) fail("Image missing or over 5MB");
  try {
    const img = sharp(buf, { failOnError: true });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
      fail("Image too small (min 64×64)");
    }
    return img;
  } catch {
    fail("Not a readable image (PNG/JPEG/WebP)");
  }
}

// Square-crop center, resize, flatten onto the station dark plate.
async function squareOnPlate(buf: Buffer, size: number, plate = "#06101e"): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const side = Math.min(meta.width || size, meta.height || size);
  return sharp(buf)
    .resize(side, side, { fit: "cover", position: "center" })
    .resize(size, size)
    .flatten({ background: plate })
    .png()
    .toBuffer();
}

async function maskable(buf: Buffer, size: number): Promise<Buffer> {
  const inner = Math.round(size * 0.62);
  const logo = await sharp(buf)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 3, background: "#06101e" },
  })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toBuffer();
}

/** Regenerate every icon + favicon from a source image buffer. */
export async function regenerateIcons(source: Buffer): Promise<string[]> {
  await fs.mkdir(ICONS_DIR, { recursive: true });
  const jobs: [string, Buffer][] = [
    ["apple-touch-icon.png", await squareOnPlate(source, 180)],
    ["icon-192.png", await squareOnPlate(source, 192)],
    ["icon-512.png", await squareOnPlate(source, 512)],
    ["favicon-32x32.png", await squareOnPlate(source, 32)],
    ["icon-192-maskable.png", await maskable(source, 192)],
    ["icon-512-maskable.png", await maskable(source, 512)],
  ];
  const written: string[] = [];
  for (const [name, data] of jobs) {
    await fs.writeFile(path.join(ICONS_DIR, name), data);
    written.push(`icons/${name}`);
  }
  const ico = await pngToIco([
    await squareOnPlate(source, 16),
    await squareOnPlate(source, 32),
    await squareOnPlate(source, 48),
  ]);
  await fs.writeFile(BRAND_PATHS.favicon, ico as unknown as Buffer);
  written.push("favicon.ico");
  return written;
}

/** kind=logo rewrites the logo AND all icons; kind=icon only icons; kind=background the backdrop. */
export async function applyBrandingUpload(
  kind: "logo" | "icon" | "background",
  buf: Buffer
): Promise<string[]> {
  const img = await readImage(buf);
  const normalized = await img.png().toBuffer();
  if (kind === "background") {
    const jpg = await sharp(normalized).jpeg({ quality: 82 }).toBuffer();
    await fs.writeFile(BRAND_PATHS.background, jpg);
    return ["bg.jpg"];
  }
  if (kind === "logo") {
    const logo = await sharp(normalized)
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    await fs.writeFile(BRAND_PATHS.logo, logo);
    return ["official_logo.png", ...(await regenerateIcons(normalized))];
  }
  return regenerateIcons(normalized);
}
