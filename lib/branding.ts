import sharp, { type Sharp } from "sharp";
import pngToIco from "png-to-ico";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BRAND_DIR } from "./brandpaths";

// Uploads go to data/brand/, NOT to public/.
//
// They used to overwrite public/official_logo.png and friends in place, which
// meant the operator's artwork and the repository's placeholder were the same
// file. Every deploy then re-uploaded the placeholder over it, and any branding
// set through the dashboard was destroyed by the next deploy. The two are
// separate now; see lib/brandpaths.ts, which decides what each public URL
// resolves to.
const ICONS_DIR = path.join(BRAND_DIR, "icons");

export const BRAND_PATHS = {
  logo: path.join(BRAND_DIR, "logo.png"),
  background: path.join(BRAND_DIR, "bg.jpg"),
  favicon: path.join(BRAND_DIR, "favicon.ico"),
} as const;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function fail(msg: string): never {
  throw new Error(msg);
}

async function readImage(buf: Buffer): Promise<Sharp> {
  if (!buf?.length || buf.length > MAX_UPLOAD_BYTES) fail("Image missing or over 5MB");
  try {
    // `failOnError` was removed from sharp's options in 0.33; `failOn` is the
    // supported spelling and behaves the same for a corrupt upload.
    const img = sharp(buf, { failOn: "error" });
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
  // Recursive, so this creates data/brand/ as well as data/brand/icons/.
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

  // data/ is gitignored, so data/brand/ does not exist on a fresh install and is
  // not carried across a deploy. Without this the first upload of a logo or a
  // background fails with ENOENT — and only the logo and background, since
  // regenerateIcons already made its own directory, so the icon button would keep
  // working while the other two did not.
  await fs.mkdir(BRAND_DIR, { recursive: true });
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
    return ["logo.png", ...(await regenerateIcons(normalized))];
  }
  return regenerateIcons(normalized);
}
