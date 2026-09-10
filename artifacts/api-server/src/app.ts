import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { GeminiServiceError } from "./services/gemini";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const isValidation = error instanceof Error && error.name === "ValidationError";
  const isGemini = error instanceof GeminiServiceError;
  if (isGemini) {
    const status = error.code === "missing_key" ? 503 : error.code === "rate_limit" ? 429 : 503;
    const message =
      error.code === "missing_key"
        ? "لم يتم إعداد خدمة الذكاء الاصطناعي."
        : error.code === "rate_limit"
          ? "تم الوصول إلى حد الاستخدام. حاول لاحقًا."
          : "تعذر الاتصال بخدمة الذكاء الاصطناعي. حاول مرة أخرى.";
    res.status(status).json({ error: message });
    return;
  }
  if (isValidation || error instanceof Error) {
    res.status(isValidation ? 400 : 500).json({
      error: isValidation ? error.message : (error instanceof Error ? error.message : String(error)),
    });
    return;
  }
  res.status(500).json({ error: "حدث خطأ غير متوقع. حاول مرة أخرى." });
});

export default app;
