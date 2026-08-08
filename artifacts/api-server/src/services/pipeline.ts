import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESULT_TTL_MS, TRANSLATION_MODEL } from "../config";
import { analyzeImage, type TextRegion } from "./gemini";
import { renderTranslatedImage } from "./renderer";

type StoredFile = { path: string; contentType: string };
type StoredResult = { createdAt: number; files: Map<string, StoredFile> };
const results = new Map<string, StoredResult>();
const resultRoot = path.join(os.tmpdir(), "scanlex-ai");

await fs.mkdir(resultRoot, { recursive: true });

setInterval(() => {
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const [id, result] of results) {
    if (result.createdAt < cutoff) {
      results.delete(id);
      void fs.rm(path.join(resultRoot, id), { recursive: true, force: true });
    }
  }
}, 10 * 60 * 1000).unref();

async function saveFile(
  resultId: string,
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const directory = path.join(resultRoot, resultId);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, key);
  await fs.writeFile(filePath, buffer);
  const result = results.get(resultId);
  result?.files.set(key, { path: filePath, contentType });
}

export function getStoredFile(resultId: string, key: string): StoredFile | undefined {
  const result = results.get(resultId);
  if (!result) return undefined;
  result.createdAt = Date.now();
  return result.files.get(key);
}

export async function translatePage(
  original: Buffer,
  mimeType: string,
  targetLanguage: string,
  resultId = randomUUID(),
  pageNumber?: number,
) {
  if (!results.has(resultId)) results.set(resultId, { createdAt: Date.now(), files: new Map() });
  const regions: TextRegion[] = await analyzeImage(original, mimeType, targetLanguage);
  const rendered = await renderTranslatedImage(original, regions);
  const suffix = pageNumber ? `page-${pageNumber}` : "image";
  await saveFile(resultId, `${suffix}-original`, original, mimeType);
  await saveFile(resultId, `${suffix}-translated`, rendered.buffer, "image/png");
  const urlPrefix = `/api/files/${resultId}`;
  return {
    pageNumber,
    originalImage: `${urlPrefix}/${suffix}-original`,
    translatedImage: `${urlPrefix}/${suffix}-translated`,
    width: rendered.width,
    height: rendered.height,
    regions,
  };
}

export function canUseThreeChapterMode(): boolean {
  return true;
}

export { TRANSLATION_MODEL };