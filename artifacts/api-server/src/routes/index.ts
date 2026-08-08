import { Router, type IRouter } from "express";
import healthRouter from "./health";
import translationRouter from "./translation";

const router: IRouter = Router();

router.use(healthRouter);
router.use(translationRouter);

export default router;
