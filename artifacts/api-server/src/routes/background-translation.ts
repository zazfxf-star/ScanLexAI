import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import {
  MAX_CHAPTER_BYTES,
  isSupportedLanguage,
} from "../config";
import {
  createChapterJob,
  getChapterJob,
  getCompletedChapterResult,
} from "../services/chapter-jobs";

const router: IRouter = Router();

const chapterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHAPTER_BYTES, files: 51 },
});

const asyncRoute = (handler: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

function requireTargetLanguage(value: unknown): string {
  const language = typeof value === "string" ? value : "";
  if (!isSupportedLanguage(language)) {
    const error = new Error("Unsupported target language");
    error.name = "ValidationError";
    throw error;
  }
  return language;
}

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

    const source = archive ?? images[0];
    const extraImages = archive ? images : images.slice(1);
    const targetLanguage = requireTargetLanguage(req.body.targetLanguage);
    const job = createChapterJob(source, extraImages, targetLanguage);

    res.status(202).json({
      jobId: job.jobId,
      status: job.status,
      name: job.name,
      targetLanguage: job.targetLanguage,
    });
  }),
);

router.get(
  "/translate/chapter/:jobId/status",
  asyncRoute(async (req, res) => {
    const jobId = String(req.params.jobId);
    const job = getChapterJob(jobId);

    if (!job) {
      res.status(404).json({ error: "Chapter translation job not found or expired." });
      return;
    }

    const result = job.complete ? getCompletedChapterResult(jobId) : null;
    res.json({
      ...job,
      result,
    });
  }),
);

export default router;