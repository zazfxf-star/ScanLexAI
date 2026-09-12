import express from "express";
import cors from "cors";
import backgroundTranslationRoutes from "./routes/background-translation";
import translationRoutes from "./routes/translation";

const app = express();

// إعطاء منفذ افتراضي 3001 إذا لم يتم التحديد لعدم إيقاف السيرفر
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/backend", backgroundTranslationRoutes);
app.use("/backend", translationRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`API Server is running on port ${PORT}`);
});
