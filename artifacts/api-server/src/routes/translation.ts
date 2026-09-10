import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_CHAPTER_BYTES,
  MAX_IMAGE_BYTES,
  TRANSLATION_MODEL,
  isSupportedLanguage,
  supportedLanguages,
} from "../config";
import { extractChapter } from "../services/archive";
import {
  getAllStoredPages,
  saveStoredFile,
  translatePage,
} from "../services/pipeline";

const router: IRouter = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});

const chapterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHAPTER_BYTES, files: 51 },
});

const asyncRoute = (handler: RequestHandler): RequestHandler =>
  (req, res, next) =>
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

function normalizeTranslationResult(rawResult: any, fileBuffer: Buffer, mimeType: string) {
  const result = (rawResult && typeof rawResult === "object" && "data" in rawResult)
    ? rawResult.data
    : rawResult;

  const originalImageBase64 = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
  let translatedImage = result?.translatedImage || originalImageBase64;

  return {
    ...result,
    originalImage: originalImageBase64,
    translatedImage,
    width: result?.width || 0,
    height: result?.height || 0,
    regions: Array.isArray(result?.regions) ? result.regions : [],
  };
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

    const rawResult = await translatePage(file.buffer, file.mimetype, targetLanguage);
    const normalized = normalizeTranslationResult(rawResult, file.buffer, file.mimetype);
    const resultId = randomUUID();

    if (rawResult.translatedBuffer) {
      saveStoredFile(resultId, "translated", rawResult.translatedBuffer, "image/png");
    }

    res.json({
      id: resultId,
      ...normalized,
      targetLanguage,
      model: TRANSLATION_MODEL,
    });
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

    const pages = await extractChapter(archive ?? images[0], archive ? images : images.slice(1));
    const resultId = randomUUID();
    const chapterName = source.originalname.replace(/\.(zip|cbz)$/i, "");

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-cache");
    res.status(200);

    res.write(
      `{\n"id": ${JSON.stringify(resultId)},\n"name": ${JSON.stringify(chapterName)},\n"pageCount": ${pages.length},\n"targetLanguage": ${JSON.stringify(targetLanguage)},\n"model": ${JSON.stringify(TRANSLATION_MODEL)},\n"pages": [\n`
    );

    // تم التعديل إلى 4 لتطابق عدد مفاتيح الـ API وتمنع سقوط الصفحات
    const BATCH_SIZE = 4;

    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (page, batchIdx) => {
          const globalIdx = i + batchIdx;
          let rawResult: any = null;
          try {
            const __t0 = Date.now(); 
            rawResult = await translatePage(page.buffer, page.mimeType, targetLanguage); 
            console.log(`[Timing] Page ${globalIdx + 1} took ${Date.now() - __t0}ms`);
          } catch (err) {
            console.error(`[ScanLex Error] فشلت ترجمة الصفحة ${globalIdx + 1}:`, err);
          }

          const normalized = normalizeTranslationResult(rawResult, page.buffer, page.mimeType);

          if (rawResult?.translatedBuffer) {
            saveStoredFile(
              resultId,
              `page-${globalIdx + 1}-translated`,
              rawResult.translatedBuffer,
              "image/png"
            );
          }

          page.buffer = Buffer.alloc(0);

          return {
            pageNumber: globalIdx + 1,
            ...normalized,
          };
        })
      );

      for (let b = 0; b < batchResults.length; b += 1) {
        const pageData = batchResults[b];
        const isLast = i + b === pages.length - 1;
        res.write(JSON.stringify(pageData) + (isLast ? "" : ",\n"));
      }

      // استراحة 800 ملي ثانية بين كل دفعة عشان نتفادى الـ Rate Limit حق جوجل
      if (i + BATCH_SIZE < pages.length) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    res.write("\n]\n}");
    res.end();
  }),
);

router.get(
  ["/files/:resultId/chapter.cbz", "/files/:resultId/chapter.zip"],
  asyncRoute(async (req, res) => {
    const resultId = String(req.params.resultId);
    const pages = getAllStoredPages(resultId);

    if (!pages || pages.length === 0) {
      res.status(404).json({ error: "Chapter not found or expired." });
      return;
    }

    try {
      const JSZipModule = await import("jszip");
      const JSZip = JSZipModule.default || JSZipModule;
      const zip = new JSZip();

      pages.forEach((p, idx) => {
        const pageNum = String(idx + 1).padStart(3, "0");
        zip.file(`page_${pageNum}.png`, p.buffer);
      });

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      res.setHeader("Content-Type", "application/x-cbz");
      res.setHeader("Content-Disposition", `attachment; filename="scanlex-translated-${resultId.slice(0, 8)}.cbz"`);
      res.send(zipBuffer);
    } catch (err) {
      console.error("[ScanLex Download Error]", err);
      res.status(500).json({ error: "Zip module is loading, please retry in a few seconds." });
    }
  }),
);

export default router;
