import express from "express";
import { getPickupReceiveSerials, getPickupReceives } from "../../controllers/admin/receive.pickup.controller.js";
import { auth } from "../../middlewares/auth.js";

const router = express.Router();

router.use(auth);
router.get("/", getPickupReceives);
router.get("/:sourceType/:receiveId/serials", getPickupReceiveSerials);

export default router;
