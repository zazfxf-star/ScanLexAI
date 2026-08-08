import path from "node:path";
import unzipper from "unzipper";
import { MAX_CHAPTER_PAGES } from "../config";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const imageMimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export type ImageInput = { buffer: Buffer; mimeType: string; name: string };

function sortPages(a: ImageInput, b: ImageInput): number {
  const getNumber = (name: string) => {
    const match = path.basename(name).match(/\d+/g);
    return match ? Number(match.at(-1)) : Number.MAX_SAFE_INTEGER;
  };
  const aNumber = getNumber(a.name);
  const bNumber = getNumber(b.name);
  return aNumber - bNumber || a.name.localeCompare(b.name, undefined, { numeric: true });
}

function safeArchivePath(fileName: string): boolean {
  const normalized = path.posix.normalize(fileName.replaceAll("\\", "/"));
  return !normalized.startsWith("../") && normalized !== ".." && !path.posix.isAbsolute(normalized);
}

export async function extractChapter(
  file: { buffer: Buffer; originalname: string; mimetype: string },
  extraImages: Array<{ buffer: Buffer; originalname: string; mimetype: string }>,
): Promise<ImageInput[]> {
  const extension = path.extname(file.originalname).toLowerCase();
  const directImages: ImageInput[] = [...extraImages, ...(imageExtensions.has(extension) ? [file] : [])].map((image) => ({
    buffer: image.buffer,
    mimeType: imageMimeTypes.get(path.extname(image.originalname).toLowerCase()) ?? image.mimetype,
    name: image.originalname,
  }));
  if (directImages.length) {
    return directImages.sort(sortPages).slice(0, MAX_CHAPTER_PAGES);
  }
  if (![".zip", ".cbz"].includes(extension)) {
    throw new Error("Unsupported chapter format");
  }

  const directory = await unzipper.Open.buffer(file.buffer);
  const pages: ImageInput[] = [];
  for (const entry of directory.files) {
    if (entry.type !== "File" || !safeArchivePath(entry.path)) continue;
    const entryExtension = path.extname(entry.path).toLowerCase();
    if (!imageExtensions.has(entryExtension)) continue;
    const buffer = await entry.buffer();
    pages.push({
      buffer,
      mimeType: imageMimeTypes.get(entryExtension) ?? "application/octet-stream",
      name: entry.path,
    });
    if (pages.length > MAX_CHAPTER_PAGES) break;
  }
  if (!pages.length) throw new Error("No supported images found in chapter");
  return pages.sort(sortPages);
}