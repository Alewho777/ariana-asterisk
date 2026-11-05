const mobileOutboundService = require("./mobile-outbound.service");
const mobileMediaService = require("./mobile-media.service");

async function create(req, res, next) {
    try {
        const call = await mobileOutboundService.createMobileCall(req.body || {});
        res.status(201).json({
            ok: true,
            outbound_call_id: call.outbound_call_id,
            linkedid: call.linkedid,
            ws_url: call.ws_url,
            data: call,
        });
    } catch (error) {
        next(error);
    }
}

function index(req, res, next) {
    try {
        const calls = mobileOutboundService.listCalls();
        res.json({
            ok: true,
            total: calls.length,
            data: calls,
        });
    } catch (error) {
        next(error);
    }
}

async function show(req, res, next) {
    try {
        const call = await mobileOutboundService.getCall(req.params.outboundCallId);
        if (!call) {
            return res.status(404).json({ ok: false, message: "Call not found" });
        }
        return res.json({ ok: true, data: call });
    } catch (error) {
        return next(error);
    }
}

async function showByLinkedId(req, res, next) {
    try {
        const call = await mobileOutboundService.getCallByLinkedId(req.params.linkedid);
        const mediaSession = mobileMediaService.getMediaSession(req.params.linkedid);
        if (!call && !mediaSession) {
            return res.status(404).json({ ok: false, message: "Call not found" });
        }
        return res.json({
            ok: true,
            data: {
                call: call || null,
                media_session: mediaSession || null,
            },
        });
    } catch (error) {
        return next(error);
    }
}

async function startMediaSession(req, res, next) {
    try {
        const session = await mobileMediaService.startMediaSessionByLinkedId(req.params.linkedid, {
            agentId: req.body?.agent_id || req.body?.agentId || null,
            tenant: req.body?.tenant || req.body?.database || null,
            outboundCallId: req.body?.outbound_call_id || req.body?.outboundCallId || null,
            direction: req.body?.direction || "OUTBOUND",
        });
        res.json({
            ok: true,
            ws_url: session.agentWebSocketUrl,
            linkedid: session.linkedid,
            data: session,
        });
    } catch (error) {
        next(error);
    }
}

async function closeMediaSession(req, res, next) {
    try {
        const session = await mobileMediaService.closeMediaSession(
            req.params.linkedid,
            req.body?.reason || "closed_by_mobile_api"
        );
        if (!session) {
            return res.status(404).json({ ok: false, message: "Mobile media session not found" });
        }
        return res.json({ ok: true, data: session });
    } catch (error) {
        return next(error);
    }
}

async function hangup(req, res, next) {
    try {
        const result = await mobileOutboundService.hangup(req.params.outboundCallId, req.body?.reason);
        res.json({ ok: true, data: result });
    } catch (error) {
        next(error);
    }
}

async function answer(req, res, next) {
    try {
        const result = await mobileOutboundService.answerCall(req.params.linkedid, req.body || {});
        res.json({ ok: true, data: result });
    } catch (error) {
        next(error);
    }
}

async function hangupCall(req, res, next) {
    try {
        const result = await mobileOutboundService.hangupByLinkedId(req.params.linkedid, req.body?.reason);
        res.json({ ok: true, data: result });
    } catch (error) {
        next(error);
    }
}

module.exports = {
    create,
    index,
    show,
    showByLinkedId,
    startMediaSession,
    closeMediaSession,
    hangup,
    answer,
    hangupCall,
};

