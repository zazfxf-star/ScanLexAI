import { renderTranslatedImage } from "./renderer";
import { analyzeImage } from "./gemini";

// مخزن مؤقت لتخزين صفحات الفصل المترجمة لإنشاء ملف الـ CBZ عند التحميل
const storageCache = new Map<string, Map<string, { buffer: Buffer; contentType: string }>>();

export function saveStoredFile(resultId: string, fileKey: string, buffer: Buffer, contentType = "image/png") {
  if (!storageCache.has(resultId)) {
    storageCache.set(resultId, new Map());
  }
  storageCache.get(resultId)!.set(fileKey, { buffer, contentType });
}

export function getStoredFile(resultId: string, fileKey: string) {
  const chapterMap = storageCache.get(resultId);
  if (!chapterMap) return null;
  const item = chapterMap.get(fileKey);
  if (!item) return null;
  return {
    path: "",
    contentType: item.contentType,
    buffer: item.buffer,
  };
}

export function getAllStoredPages(resultId: string) {
  const chapterMap = storageCache.get(resultId);
  if (!chapterMap) return [];
  const pages: { name: string; buffer: Buffer }[] = [];

  chapterMap.forEach((val, key) => {
    if (key.includes("-translated")) {
      pages.push({ name: `${key}.png`, buffer: val.buffer });
    }
  });

  pages.sort((a, b) => {
    const numA = parseInt(a.name.match(/\d+/)?.[0] || "0");
    const numB = parseInt(b.name.match(/\d+/)?.[0] || "0");
    return numA - numB;
  });

  return pages;
}

export async function translatePage(
  imageBuffer: Buffer,
  mimeType: string,
  targetLanguage: string
) {
  const regions = await analyzeImage(imageBuffer, mimeType, targetLanguage);

  if (!regions || regions.length === 0) {
    return {
      translatedImage: `data:${mimeType};base64,${imageBuffer.toString("base64")}`,
      translatedBuffer: imageBuffer,
      regions: [],
    };
  }

  const { buffer: translatedBuffer, width, height } = await renderTranslatedImage(
    imageBuffer,
    regions
  );

  return {
    translatedImage: `data:image/png;base64,${translatedBuffer.toString("base64")}`,
    translatedBuffer,
    width,
    height,
    regions,
  };
}

export function canUseThreeChapterMode() {
  return true;
}