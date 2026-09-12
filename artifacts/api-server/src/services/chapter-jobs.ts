import { extractChapter, type ImageInput } from "./archive";
import { translatePage, saveStoredFile } from "./pipeline";
import { TRANSLATION_MODEL } from "../config";

type UploadedChapterFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
};

type JobState = "queued" | "processing" | "completed" | "failed";

export type ChapterJobPage = {
  pageNumber: number;
  originalImage: string;
  translatedImage: string;
  width: number;
  height: number;
  regions: unknown[];
};

export type ChapterJobSnapshot = {
  jobId: string;
  status: JobState;
  name: string;
  targetLanguage: string;
  model: string;
  totalPages: number | null;
  completedPages: number;
  succeededPages: number[];
  failedPages: number[];
  currentPage: number | null;
  complete: boolean;
  resultId: string | null;
  pages: ChapterJobPage[];
  error: string | null;
};

type ChapterJob = ChapterJobSnapshot & {
  source: UploadedChapterFile;
  extraImages: UploadedChapterFile[];
};

const jobs = new Map<string, ChapterJob>();
const BATCH_SIZE = 4;

function normalizeTranslationResult(
  rawResult: any,
  fileBuffer: Buffer,
  mimeType: string,
) {
  const result = rawResult && typeof rawResult === "object" && "data" in rawResult
    ? rawResult.data
    : rawResult;
  const originalImage = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;

  return {
    ...result,
    originalImage,
    translatedImage: result?.translatedImage || originalImage,
    width: result?.width || 0,
    height: result?.height || 0,
    regions: Array.isArray(result?.regions) ? result.regions : [],
  };
}

function snapshot(job: ChapterJob): ChapterJobSnapshot {
  return {
    jobId: job.jobId,
    status: job.status,
    name: job.name,
    targetLanguage: job.targetLanguage,
    model: job.model,
    totalPages: job.totalPages,
    completedPages: job.completedPages,
    succeededPages: [...job.succeededPages].sort((a, b) => a - b),
    failedPages: [...job.failedPages].sort((a, b) => a - b),
    currentPage: job.currentPage,
    complete: job.status === "completed" || job.status === "failed",
    resultId: job.resultId,
    pages: job.pages.filter(Boolean),
    error: job.error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Chapter translation failed.";
}

async function runChapterJob(job: ChapterJob) {
  try {
    const pages = await extractChapter(job.source, job.extraImages);
    job.totalPages = pages.length;
    job.status = "processing";

    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (page, batchIndex) => {
          const globalIndex = i + batchIndex;
          const pageNumber = globalIndex + 1;
          job.currentPage = pageNumber;

          try {
            const rawResult = await translatePage(
              page.buffer,
              page.mimeType,
              job.targetLanguage,
            );
            const normalized = normalizeTranslationResult(
              rawResult,
              page.buffer,
              page.mimeType,
            );

            if (rawResult?.translatedBuffer) {
              saveStoredFile(
                job.jobId,
                `page-${pageNumber}-translated`,
                rawResult.translatedBuffer,
                "image/png",
              );
            }

            job.pages[globalIndex] = {
              pageNumber,
              ...normalized,
            };
            job.succeededPages.push(pageNumber);
          } catch (error) {
            console.error(
              `[ScanLex Background Error] Page ${pageNumber} failed:`,
              error,
            );

            const normalized = normalizeTranslationResult(
              null,
              page.buffer,
              page.mimeType,
            );

            // Preserve the original page in the existing download cache so a
            // partial job still produces a complete archive.
            saveStoredFile(
              job.jobId,
              `page-${pageNumber}-translated`,
              page.buffer,
              page.mimeType,
            );
            job.pages[globalIndex] = {
              pageNumber,
              ...normalized,
            };
            job.failedPages.push(pageNumber);
          } finally {
            job.completedPages += 1;
            page.buffer = Buffer.alloc(0);
          }
        }),
      );

      if (i + BATCH_SIZE < pages.length) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    job.currentPage = null;
    job.status = "completed";
  } catch (error) {
    job.currentPage = null;
    job.status = "failed";
    job.error = errorMessage(error);
    console.error(`[ScanLex Background Error] Job ${job.jobId} failed:`, error);
  } finally {
    job.source.buffer = Buffer.alloc(0);
    job.extraImages.forEach((image) => {
      image.buffer = Buffer.alloc(0);
    });
  }
}

export function createChapterJob(
  source: UploadedChapterFile,
  extraImages: UploadedChapterFile[],
  targetLanguage: string,
) {
  const jobId = crypto.randomUUID();
  const name = source.originalname.replace(/\.(zip|cbz)$/i, "");
  const job: ChapterJob = {
    jobId,
    status: "queued",
    name,
    targetLanguage,
    model: TRANSLATION_MODEL,
    totalPages: null,
    completedPages: 0,
    succeededPages: [],
    failedPages: [],
    currentPage: null,
    complete: false,
    resultId: jobId,
    pages: [],
    error: null,
    source,
    extraImages,
  };

  jobs.set(jobId, job);
  void runChapterJob(job);
  return snapshot(job);
}

export function getChapterJob(jobId: string) {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : null;
}

export function getCompletedChapterResult(jobId: string) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "completed") return null;

  return {
    id: job.jobId,
    name: job.name,
    pageCount: job.totalPages ?? job.pages.length,
    pages: job.pages,
    targetLanguage: job.targetLanguage,
    model: job.model,
  };
}