const ariService = require("../ari/ari.service");
const mobileMediaService = require("./mobile-media.service");

async function sendDtmf(req, res, next) {
    try {
        const { linkedid } = req.params;
        const digit = String(req.body?.digit || req.body?.dtmf || "").trim().toUpperCase();
        const durationMs = Math.max(
            50,
            Math.min(5000, parseInt(req.body?.duration_ms || req.body?.duration || 250, 10) || 250)
        );

        if (!/^[0-9*#A-D]+$/.test(digit)) {
            return res.status(400).json({
                ok: false,
                error: `Dígito DTMF inválido: "${digit}". Permitidos: 0-9, *, #, A-D`,
            });
        }

        // Resuelve el canal activo de la llamada
        const session = ariService.getSessionByLinkedId(linkedid);
        const mediaSession = mobileMediaService.getMediaSession(linkedid);
        const channelId = session?.channelId || mediaSession?.channelId || session?.externalChannelId || linkedid;

        console.log("[mobile:dtmf] sending DTMF", {
            linkedid,
            channelId,
            digit,
            durationMs,
        });

        // Envía el comando DTMF a Asterisk ARI vía ariRequest existente
        await ariService.ariRequest("POST", `/channels/${encodeURIComponent(channelId)}/dtmf`, {
            params: { dtmf: digit, duration: durationMs },
            data: { dtmf: digit, duration: durationMs },
        });

        return res.json({
            ok: true,
            linkedid,
            channelId,
            digit,
            durationMs,
        });
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    sendDtmf,
};

