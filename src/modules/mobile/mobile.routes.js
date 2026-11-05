const express = require("express");

const mobileOutboundController = require("./mobile-outbound.controller");
const mobileDtmfController = require("./mobile-dtmf.controller");
const requireApiToken = require("../../middlewares/api-token.middleware");

const router = express.Router();

router.use(requireApiToken);

// Llamadas Salientes Móvil
router.get("/outbound-calls", mobileOutboundController.index);
router.post("/outbound-calls", mobileOutboundController.create);
router.get("/outbound-calls/:outboundCallId", mobileOutboundController.show);
router.post("/outbound-calls/:outboundCallId/hangup", mobileOutboundController.hangup);

// Control de Llamada Activa Móvil
router.get("/calls/:linkedid", mobileOutboundController.showByLinkedId);
router.post("/calls/:linkedid/media-session", mobileOutboundController.startMediaSession);
router.post("/calls/:linkedid/media-session/close", mobileOutboundController.closeMediaSession);
router.post("/calls/:linkedid/dtmf", mobileDtmfController.sendDtmf);
router.post("/calls/:linkedid/answer", mobileOutboundController.answer);
router.post("/calls/:linkedid/hangup", mobileOutboundController.hangupCall);

module.exports = router;

