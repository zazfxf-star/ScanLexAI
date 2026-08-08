import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import * as archiver from "archiver";
import path from "node:path";
import {
  MAX_CHAPTER_BYTES,
  MAX_IMAGE_BYTES,
  TRANSLATION_MODEL,
  isSupportedLanguage,
  supportedLanguages,
} from "../config";
import { extractChapter } from "../services/archive";
import { GeminiServiceError } from "../services/gemini";
import { canUseThreeChapterMode, getStoredFile, translatePage } from "../services/pipeline";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});
const chapterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHAPTER_BYTES, files: 51 },
});

const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function requireLanguage(value: unknown): string {
  const language = typeof value === "string" ? value : "";
  if (!isSupportedLanguage(language)) {
    const error = new Error("Unsupported target language");
    error.name = "ValidationError";
    throw error;
  }
  return language;
}

function ensureImage(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) {
    const error = new Error("نوع الملف غير مدعوم.");
    error.name = "ValidationError";
    throw error;
  }
  const extension = path.extname(file.originalname).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
    const error = new Error("نوع الملف غير مدعوم.");
    error.name = "ValidationError";
    throw error;
  }
  if (!file.mimetype.startsWith("image/")) {
    const error = new Error("تعذر قراءة الصورة.");
    error.name = "ValidationError";
    throw error;
  }
  return file;
}

router.get("/config", (_req, res) => {
  res.json({
    serviceConfigured: Boolean(process.env.GEMINI_API_KEY),
    model: TRANSLATION_MODEL,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxChapterBytes: MAX_CHAPTER_BYTES,
    supportedLanguages,
  });
});

router.post(
  "/translate/image",
  imageUpload.single("file"),
  asyncRoute(async (req, res) => {
    const file = ensureImage(req.file);
    const targetLanguage = requireLanguage(req.body.targetLanguage);
    const result = await translatePage(file.buffer, file.mimetype, targetLanguage);
    res.json({ id: result.originalImage.split("/")[3], ...result, targetLanguage, model: TRANSLATION_MODEL });
  }),
);

router.post(
  "/translate/chapter",
  chapterUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "images", maxCount: 50 },
  ]),
  asyncRoute(async (req, res) => {
    const fields = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const archive = fields.file?.[0];
    const images = fields.images ?? [];
    if (!archive && !images.length) {
      const error = new Error("لم يتم اختيار ملف فصل.");
      error.name = "ValidationError";
      throw error;
    }
    const targetLanguage = requireLanguage(req.body.targetLanguage);
    const source = archive ?? images[0];
    const pages = await extractChapter(
      archive ?? images[0],
      archive ? images : images.slice(1),
    );
    const resultId = randomUUID();
    const translatedPages = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      translatedPages.push(
        await translatePage(page.buffer, page.mimeType, targetLanguage, resultId, index + 1),
      );
    }
    res.json({
      id: resultId,
      name: source.originalname.replace(/\.(zip|cbz)$/i, ""),
      pageCount: translatedPages.length,
      pages: translatedPages,
      targetLanguage,
      model: TRANSLATION_MODEL,
    });
  }),
);

router.post(
  "/translate/chapters",
  chapterUpload.array("files", 3),
  asyncRoute(async (req, res) => {
    if (!canUseThreeChapterMode()) {
      const error = new Error("Three chapter mode is unavailable");
      error.name = "ValidationError";
      throw error;
    }
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length || files.length > 3) {
      const error = new Error("اختر من فصل واحد إلى ثلاثة فصول.");
      error.name = "ValidationError";
      throw error;
    }
    const targetLanguage = requireLanguage(req.body.targetLanguage);
    const chapters = [];
    for (const file of files) {
      const pages = await extractChapter(file, []);
      const resultId = randomUUID();
      const translatedPages = [];
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        translatedPages.push(
          await translatePage(page.buffer, page.mimeType, targetLanguage, resultId, index + 1),
        );
      }
      chapters.push({
        id: resultId,
        name: file.originalname.replace(/\.(zip|cbz)$/i, ""),
        pageCount: translatedPages.length,
        pages: translatedPages,
        targetLanguage,
        model: TRANSLATION_MODEL,
      });
    }
    res.json({ id: randomUUID(), chapterCount: chapters.length, chapters, targetLanguage });
  }),
);

router.get("/files/:resultId/chapter.zip", asyncRoute(async (req, res) => {
  const resultId = String(req.params.resultId);
  const result = getStoredFile(resultId, "page-1-translated");
  if (!result) {
    res.status(404).json({ error: "Chapter not found or expired." });
    return;
  }
  res.attachment("scanlex-translated-chapter.zip");
  const archive = new archiver.ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (error: Error) => {
    if (!res.headersSent) res.status(500).json({ error: "Unable to create chapter download." });
  });
  archive.pipe(res);
  for (let pageNumber = 1; pageNumber <= 60; pageNumber += 1) {
    const page = getStoredFile(resultId, `page-${pageNumber}-translated`);
    if (!page) break;
    archive.file(page.path, { name: `page-${String(pageNumber).padStart(3, "0")}.png` });
  }
  await archive.finalize();
}));

router.get("/files/:resultId/:fileKey", asyncRoute(async (req, res) => {
  const resultId = String(req.params.resultId);
  const fileKey = String(req.params.fileKey);
  const stored = getStoredFile(resultId, fileKey);
  if (!stored) {
    res.status(404).json({ error: "Result file not found or expired." });
    return;
  }
  res.type(stored.contentType);
  res.sendFile(stored.path);
}));

export default router;