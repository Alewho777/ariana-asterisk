const crypto = require("crypto");

const env = require("../../config/env");
const ariService = require("../ari/ari.service");
const laravelService = require("../laravel/laravel.service");
const pbxService = require("../pbx/pbx.service");
const mobileMediaService = require("./mobile-media.service");

const FINAL_STATUSES = new Set([
    "BUSY",
    "NOANSWER",
    "FAILED",
    "CANCELLED",
    "ENDED",
]);

class MobileOutboundService {
    constructor(options = {}) {
        this.env = options.env || env;
        this.pbxService = options.pbxService || pbxService;
        this.ariService = options.ariService || ariService;
        this.laravelService = options.laravelService || laravelService;
        this.mobileMediaService = options.mobileMediaService || mobileMediaService;
        this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
        this.now = options.now || (() => new Date());
        this.callsById = new Map();
        this.callsByActionId = new Map();
        this.callsByLinkedId = new Map();

        if (typeof this.pbxService.onManagerEvent === "function") {
            this.unsubscribeManagerEvents = this.pbxService.onManagerEvent((event) => {
                this.handleManagerEvent(event);
            });
        }

        if (typeof this.pbxService.registerEventMetadataResolver === "function") {
            this.unsubscribeMetadataResolver = this.pbxService.registerEventMetadataResolver(
                (event) => this.metadataForEvent(event)
            );
        }

        if (typeof this.ariService.onSessionEvent === "function") {
            this.unsubscribeAriEvents = this.ariService.onSessionEvent((session, summary) => {
                this.handleAriSessionEvent(session, summary);
            });
        }
    }

    async createMobileCall(payload = {}) {
        this.ensureEnabled();
        this.prune();

        const input = this.validatePayload(payload);
        const outboundCallId = this.randomUUID();
        const actionId = `ariana-mobile-outbound-${outboundCallId}`;
        const generatedLinkedId = `${Math.floor(this.now().getTime() / 1000)}.${Math.floor(
            Math.random() * 900000 + 100000
        )}`;
        const now = this.timestamp();

        const wsAccess = this.mobileMediaService.createAgentWebSocketAccess(
            generatedLinkedId,
            input.agentId
        );

        const call = {
            outboundCallId,
            actionId,
            linkedid: generatedLinkedId,
            uniqueid: generatedLinkedId,
            channel: "",
            channelPrefix: `Local/${input.phoneNumber}@${this.env.pbxOriginateContext}-`,
            status: "QUEUED",
            direction: "OUTBOUND",
            clientSource: "mobile",
            clientType: "mobile",
            phoneNumber: input.phoneNumber,
            fromNumber: input.fromNumber,
            agentId: input.agentId,
            deviceId: input.deviceId,
            customerId: input.customerId,
            tenant: input.tenant,
            mode: input.mode,
            wsKey: wsAccess.key,
            wsUrl: wsAccess.url,
            wsPath: wsAccess.path,
            createdAt: now,
            updatedAt: now,
            answeredAt: null,
            endedAt: null,
            hangupCause: null,
            hangupReason: null,
            lastEvent: "outbound_requested",
            lastError: null,
            amiResponse: null,
        };

        this.remember(call);

        // Pre-registra la sesión de medios móvil para permitir conexión inmediata del WebSocket desde Flutter
        this.mobileMediaService.registerPendingMediaSession(generatedLinkedId, {
            agentId: input.agentId,
            outboundCallId,
            wsKey: wsAccess.key,
            wsUrl: wsAccess.url,
            wsPath: wsAccess.path,
            tenant: input.tenant,
            direction: "OUTBOUND",
        });

        try {
            const originate = await this.pbxService.originateOutboundApplication({
                actionId,
                phoneNumber: input.phoneNumber,
                fromNumber: input.fromNumber,
                application: "Stasis",
                applicationData: `${this.env.ariAppName},outbound,${outboundCallId}`,
                variables: this.channelVariables(call),
            });

            call.channel = String(originate.channel || "");
            call.status = "ORIGINATING";
            call.lastEvent = "originate_queued";
            call.amiResponse = this.safeAmiResponse(originate.response);
            call.updatedAt = this.timestamp();
            this.publishState(call, "originate_queued");

            return this.snapshot(call);
        } catch (error) {
            call.status = "FAILED";
            call.lastEvent = "originate_failed";
            call.lastError = error.message || String(error);
            call.endedAt = this.timestamp();
            call.updatedAt = call.endedAt;
            this.publishState(call, "originate_failed");
            await this.mobileMediaService
                .closeMediaSession(generatedLinkedId, "originate_failed")
                .catch(() => {});

            error.status = error.status || 502;
            error.outboundCallId = outboundCallId;
            throw error;
        }
    }

    listCalls() {
        this.prune();

        return [...this.callsById.values()]
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map((call) => this.snapshot(call));
    }

    async getCall(outboundCallId) {
        const key = String(outboundCallId || "").trim();
        const call = this.callsById.get(key) || this.callsByLinkedId.get(key);
        return call ? this.snapshot(call) : null;
    }

    async getCallByLinkedId(linkedid) {
        const key = String(linkedid || "").trim();
        if (!key) return null;
        const call = this.callsByLinkedId.get(key) || this.callsById.get(key);
        return call ? this.snapshot(call) : null;
    }

    async answerCall(linkedid, options = {}) {
        const key = String(linkedid || "").trim();
        const call = this.callsByLinkedId.get(key) || this.callsById.get(key);
        const targetKey = call?.linkedid || key;

        const mediaSession = await this.mobileMediaService.startMediaSessionByLinkedId(targetKey, {
            agentId: options.agent_id || options.agentId || call?.agentId || null,
            tenant: options.tenant || call?.tenant || null,
            outboundCallId: call?.outboundCallId || null,
            direction: "OUTBOUND",
        });

        return {
            call: call ? this.snapshot(call) : null,
            media_session: mediaSession,
        };
    }

    async hangup(outboundCallId, reason = "mobile_outbound_cancelled") {
        const call = this.requireCall(outboundCallId);

        if (FINAL_STATUSES.has(call.status)) {
            return this.snapshot(call);
        }

        if (call.linkedid) {
            try {
                await this.pbxService.hangupCall(call.linkedid, reason);
            } catch (error) {
                if (!call.channel) {
                    throw error;
                }
                await this.pbxService.hangupChannelByName(call.channel, reason);
            }
        } else if (call.channel) {
            await this.pbxService.hangupChannelByName(call.channel, reason);
        } else {
            const error = new Error("Mobile outbound call does not have an Asterisk channel yet");
            error.status = 409;
            throw error;
        }

        call.status = "CANCELLED";
        call.lastEvent = "hangup";
        call.hangupReason = reason;
        call.endedAt = this.timestamp();
        call.updatedAt = call.endedAt;
        this.publishState(call, "hangup", { reason });
        await this.mobileMediaService.closeMediaSession(call.linkedid, reason).catch(() => {});

        return this.snapshot(call);
    }

    async hangupByLinkedId(linkedid, reason = "mobile_hangup") {
        const key = String(linkedid || "").trim();
        const call = this.callsByLinkedId.get(key) || this.callsById.get(key);

        if (call) {
            return this.hangup(call.outboundCallId, reason);
        }

        await this.mobileMediaService.closeMediaSession(key, reason).catch(() => {});
        const result = await this.pbxService.hangupCall(key, reason);
        return result;
    }

    metadataForEvent(event = {}) {
        const call = this.findCallForEvent(event);

        if (!call) {
            return null;
        }

        if (event.linkedid || event.uniqueid || event.channel) {
            this.linkCall(call, event);
        }

        return {
            direction: "OUTBOUND",
            client_source: "mobile",
            client_type: "mobile",
            outbound_call_id: call.outboundCallId,
            external_call_id: call.linkedid || call.outboundCallId,
            phone_number: call.phoneNumber,
            from_number: call.fromNumber || undefined,
            agent_id: call.agentId,
            device_id: call.deviceId,
            customer_id: call.customerId || null,
            tenant: call.tenant || undefined,
            mode: call.mode,
        };
    }

    handleManagerEvent(event = {}) {
        try {
            const eventName = String(event.event || "").toLowerCase();
            const variableName = String(event.variable || "").replace(/^_+/, "");

            if (eventName === "varset" && variableName === "ARIANA_OUTBOUND_CALL_ID") {
                const call = this.callsById.get(String(event.value || ""));
                if (call) {
                    this.linkCall(call, event);
                }
                return;
            }

            if (eventName === "originateresponse") {
                this.handleOriginateResponse(event);
                return;
            }

            const call = this.findCallForEvent(event);
            if (!call) {
                return;
            }

            this.linkCall(call, event);
            this.applyManagerStatus(call, event);
        } catch (error) {
            console.warn("[mobile:outbound] manager event processing failed", {
                event: event.event || null,
                linkedid: event.linkedid || null,
                message: error.message,
            });
        }
    }

    handleAriSessionEvent(session = {}, summary = {}) {
        try {
            const args = Array.isArray(session.stasisArgs)
                ? session.stasisArgs.map((value) => String(value))
                : [];
            const outboundCallId = args.find((value) => this.callsById.has(value));
            const call = outboundCallId
                ? this.callsById.get(outboundCallId)
                : this.callsByLinkedId.get(String(session.linkedid || ""));

            if (!call) {
                return;
            }

            this.linkCall(call, {
                linkedid: session.linkedid,
                uniqueid: session.channelId,
                channel: session.channel?.name,
            });

            const type = String(summary.type || "");

            if (type === "StasisStart") {
                call.status = "STASIS_READY";
                call.lastEvent = "answered";
                call.answeredAt ||= this.timestamp();
                call.updatedAt = this.timestamp();
                this.publishState(call, "answered");

                if (call.mode === "human") {
                    this.mobileMediaService
                        .startMediaSessionByLinkedId(call.linkedid, {
                            agentId: call.agentId,
                            outboundCallId: call.outboundCallId,
                            tenant: call.tenant,
                            direction: "OUTBOUND",
                        })
                        .catch((error) => {
                            console.warn("[mobile:outbound] auto start mobile media session failed", {
                                linkedid: call.linkedid,
                                message: error.message,
                            });
                        });
                }
            } else if (["StasisEnd", "ChannelDestroyed"].includes(type)) {
                call.status = "ENDED";
                call.lastEvent = "hangup";
                call.endedAt = this.timestamp();
                call.updatedAt = call.endedAt;
                this.publishState(call, "hangup");
            }
        } catch (error) {
            console.warn("[mobile:outbound] ARI event processing failed", {
                type: summary.type || null,
                linkedid: session.linkedid || null,
                message: error.message,
            });
        }
    }

    handleOriginateResponse(event) {
        const call = this.callsByActionId.get(String(event.actionId || ""));

        if (!call) {
            return;
        }

        this.linkCall(call, event);

        const response = String(event.response || "").toLowerCase();
        const reason = Number(event.reason || 0);

        if (response === "success") {
            call.status = "ANSWERED";
            call.answeredAt ||= this.timestamp();
            call.lastError = null;
            call.lastEvent = "answered";
            call.updatedAt = this.timestamp();
            this.publishState(call, "answered");
        } else {
            call.status = this.statusForOriginateFailure(reason);
            call.lastError = `AMI Originate failed${reason ? ` with reason ${reason}` : ""}`;
            call.endedAt = this.timestamp();
            call.lastEvent = call.status.toLowerCase();
            call.updatedAt = this.timestamp();
            this.publishState(call, call.status.toLowerCase(), {
                cause_code: String(reason || ""),
                reason: call.lastError,
            });
        }
    }

    applyManagerStatus(call, event) {
        const eventName = String(event.event || "").toLowerCase();
        const dialStatus = String(event.dialStatus || "").toUpperCase();
        let nextStatus = "";
        let reportedEvent = eventName;

        if (["dialbegin", "dialstate"].includes(eventName)) {
            nextStatus = "RINGING";
            reportedEvent = "ringing";
        } else if (eventName === "dialend") {
            if (dialStatus === "ANSWER") {
                nextStatus = "ANSWERED";
                reportedEvent = "answered";
            } else if (dialStatus === "BUSY") {
                nextStatus = "BUSY";
                reportedEvent = "busy";
            } else if (dialStatus === "NOANSWER") {
                nextStatus = "NOANSWER";
                reportedEvent = "noanswer";
            } else if (["CHANUNAVAIL", "CONGESTION"].includes(dialStatus)) {
                nextStatus = "FAILED";
                reportedEvent = "congestion";
            } else if (dialStatus === "CANCEL") {
                nextStatus = "CANCELLED";
                reportedEvent = "cancelled";
            } else {
                nextStatus = dialStatus;
                reportedEvent = dialStatus.toLowerCase();
            }
        } else if (eventName === "bridgeenter") {
            nextStatus = "ANSWERED";
            reportedEvent = "answered";
        } else if (eventName === "hangup") {
            nextStatus = FINAL_STATUSES.has(call.status) ? call.status : "ENDED";
            reportedEvent = "hangup";
            call.hangupCause = event.cause || event.Cause || call.hangupCause || null;
            call.hangupReason = event["cause-txt"] || event["Cause-txt"] || call.hangupReason || null;
        }

        if (!nextStatus) {
            return;
        }

        call.status = nextStatus;
        call.lastEvent = reportedEvent;
        call.updatedAt = this.timestamp();

        if (nextStatus === "ANSWERED") {
            call.answeredAt ||= call.updatedAt;
        }

        if (FINAL_STATUSES.has(nextStatus)) {
            call.endedAt ||= call.updatedAt;
        }

        this.publishState(call, reportedEvent, {
            cause_code: call.hangupCause,
            reason: call.hangupReason,
        });
    }

    findCallForEvent(event = {}) {
        const variableName = String(event.variable || "").replace(/^_+/, "");
        const outboundCallId = String(
            event.outbound_call_id ||
                event.outboundCallId ||
                (variableName === "ARIANA_OUTBOUND_CALL_ID" ? event.value : "") ||
                ""
        );

        if (outboundCallId && this.callsById.has(outboundCallId)) {
            return this.callsById.get(outboundCallId);
        }

        const actionId = String(event.actionId || "");
        if (actionId && this.callsByActionId.has(actionId)) {
            return this.callsByActionId.get(actionId);
        }

        for (const id of [event.linkedid, event.uniqueid]) {
            const value = String(id || "");
            if (value && this.callsByLinkedId.has(value)) {
                return this.callsByLinkedId.get(value);
            }
        }

        const channels = [event.channel, event.destChannel]
            .map((value) => String(value || ""))
            .filter(Boolean);
        const candidates = [...this.callsById.values()].filter((call) => {
            if (FINAL_STATUSES.has(call.status)) {
                return false;
            }
            return channels.some((channel) => channel.startsWith(call.channelPrefix));
        });

        if (candidates.length === 1) {
            return candidates[0];
        }

        return null;
    }

    linkCall(call, event = {}) {
        const candidate = String(event.linkedid || event.uniqueid || "");
        const linkedid = ["", "null", "<null>"].includes(candidate.toLowerCase())
            ? ""
            : candidate;

        if (linkedid) {
            const previousLinkedId = call.linkedid;
            call.linkedid = linkedid;
            this.callsByLinkedId.set(linkedid, call);

            // Registra el nuevo linkedid de Asterisk también en la sesión de medios móvil
            if (previousLinkedId && previousLinkedId !== linkedid) {
                const pendingMedia = this.mobileMediaService.getMediaSession(previousLinkedId);
                if (pendingMedia) {
                    this.mobileMediaService.registerPendingMediaSession(linkedid, {
                        agentId: call.agentId,
                        outboundCallId: call.outboundCallId,
                        wsKey: call.wsKey,
                        wsUrl: call.wsUrl,
                        wsPath: call.wsPath,
                        tenant: call.tenant,
                    });
                }
            }
        }

        if (event.uniqueid) {
            call.uniqueid = String(event.uniqueid);
            this.callsByLinkedId.set(call.uniqueid, call);
        }

        if (event.channel) {
            call.channel = String(event.channel);
        }

        call.updatedAt = this.timestamp();
    }

    channelVariables(call) {
        const variables = {
            __ARIANA_OUTBOUND_CALL_ID: call.outboundCallId,
            __ARIANA_DIRECTION: "OUTBOUND",
            __ARIANA_AGENT_ID: call.agentId,
            __ARIANA_DEVICE_ID: call.deviceId,
            __ARIANA_MODE: call.mode,
            __ARIANA_CLIENT_SOURCE: "mobile",
            __ARIANA_CLIENT_TYPE: "mobile",
            __ARIANA_LINKEDID: call.linkedid,
        };

        if (call.customerId) {
            variables.__ARIANA_CUSTOMER_ID = call.customerId;
        }

        if (call.tenant) {
            variables.__ARIANA_TENANT = call.tenant;
        }

        return variables;
    }

    validatePayload(payload) {
        const phoneNumber = String(payload.phone_number || payload.phoneNumber || "").trim();
        const fromNumber = String(payload.from_number || payload.fromNumber || "").trim();
        const agentId = this.positiveInteger(payload.agent_id || payload.agentId, "agent_id");
        const deviceId = this.positiveInteger(payload.device_id || payload.deviceId, "device_id");
        const customerId = this.optionalPositiveInteger(
            payload.customer_id || payload.customerId,
            "customer_id"
        );
        const tenant = String(payload.tenant || payload.database || "").trim();
        const mode = String(payload.mode || "human").trim().toLowerCase();

        if (!/^\+?[0-9]{3,20}$/.test(phoneNumber)) {
            const error = new Error("phone_number must contain between 3 and 20 digits");
            error.status = 422;
            throw error;
        }

        if (fromNumber && !/^[A-Za-z0-9+_.-]{1,80}$/.test(fromNumber)) {
            const error = new Error("from_number has an invalid format");
            error.status = 422;
            throw error;
        }

        if (tenant && !/^[A-Za-z0-9_-]{1,100}$/.test(tenant)) {
            const error = new Error("tenant has an invalid format");
            error.status = 422;
            throw error;
        }

        if (!["human", "ai"].includes(mode)) {
            const error = new Error("mode must be human or ai");
            error.status = 422;
            throw error;
        }

        return {
            phoneNumber,
            fromNumber,
            agentId,
            deviceId,
            customerId,
            tenant,
            mode,
        };
    }

    positiveInteger(value, field) {
        const parsed = Number(value);

        if (!Number.isInteger(parsed) || parsed <= 0) {
            const error = new Error(`${field} must be a positive integer`);
            error.status = 422;
            throw error;
        }

        return parsed;
    }

    optionalPositiveInteger(value, field) {
        if (value === undefined || value === null || value === "") {
            return null;
        }

        return this.positiveInteger(value, field);
    }

    statusForOriginateFailure(reason) {
        return (
            {
                1: "NOANSWER",
                5: "BUSY",
                8: "FAILED",
            }[reason] || "FAILED"
        );
    }

    ensureEnabled() {
        if (!this.env.trunkOutboundEnabled) {
            const error = new Error("Trunk outbound calls are disabled");
            error.status = 409;
            throw error;
        }
    }

    requireCall(outboundCallId) {
        const key = String(outboundCallId || "").trim();
        const call = this.callsById.get(key) || this.callsByLinkedId.get(key);

        if (!call) {
            const error = new Error("Mobile outbound call not found");
            error.status = 404;
            throw error;
        }

        return call;
    }

    remember(call) {
        this.callsById.set(call.outboundCallId, call);
        this.callsByActionId.set(call.actionId, call);
        if (call.linkedid) {
            this.callsByLinkedId.set(call.linkedid, call);
        }
    }

    prune() {
        const retentionMs = Math.max(60000, Number(this.env.trunkOutboundRetentionMs || 3600000));
        const threshold = this.now().getTime() - retentionMs;

        for (const call of this.callsById.values()) {
            const updatedAt = new Date(call.updatedAt).getTime();

            if (!FINAL_STATUSES.has(call.status) || updatedAt >= threshold) {
                continue;
            }

            this.callsById.delete(call.outboundCallId);
            this.callsByActionId.delete(call.actionId);

            for (const [linkedid, linkedCall] of this.callsByLinkedId.entries()) {
                if (linkedCall === call) {
                    this.callsByLinkedId.delete(linkedid);
                }
            }
        }
    }

    publishState(call, eventName, extra = {}) {
        if (!this.env.laravelTrunkEventsEnabled) {
            return;
        }

        const externalCallId = call.linkedid || call.outboundCallId;
        const causeCode = extra.cause_code || call.hangupCause || null;
        const hangupReason = extra.reason || call.hangupReason || null;
        const payload = {
            source: "ariana-asterisk-mobile-outbound",
            client_source: "mobile",
            client_type: "mobile",
            direction: "OUTBOUND",
            outbound_call_id: call.outboundCallId,
            device_id: call.deviceId,
            customer_id: call.customerId,
            agent_id: call.agentId,
            tenant: call.tenant || undefined,
            mode: call.mode,
            cause_code: causeCode,
            reason: hangupReason,
            event: {
                time: this.timestamp(),
                event: eventName,
                status: call.status,
                caller: call.fromNumber,
                destination: call.phoneNumber,
                linkedid: externalCallId,
                external_call_id: externalCallId,
                uniqueid: call.uniqueid,
                channel: call.channel,
                direction: "OUTBOUND",
                client_source: "mobile",
                outbound_call_id: call.outboundCallId,
                cause_code: causeCode,
                reason: hangupReason,
            },
            summary: {
                linkedid: externalCallId,
                status: call.status,
                from: call.fromNumber,
                to: call.phoneNumber,
                direction: "OUTBOUND",
                client_source: "mobile",
                outbound_call_id: call.outboundCallId,
                answered: Boolean(call.answeredAt),
                result: this.resultForStatus(call.status),
                cause_code: causeCode,
                reason: hangupReason,
            },
        };

        Promise.resolve(this.laravelService.sendTrunkCallEvent(payload)).catch((error) => {
            console.error("[mobile:laravel] callback failed", {
                outboundCallId: call.outboundCallId,
                event: eventName,
                message: error.message,
                status: error.response?.status,
            });
        });
    }

    resultForStatus(status) {
        return (
            {
                ANSWERED: "answered",
                STASIS_READY: "answered",
                BUSY: "busy",
                NOANSWER: "no_answer",
                CANCELLED: "cancelled",
                FAILED: "failed",
                ENDED: "ended",
            }[status] || "in_progress"
        );
    }

    safeAmiResponse(response) {
        if (!response || typeof response !== "object") {
            return response || null;
        }

        return {
            response: response.response || response.Response || null,
            message: response.message || response.Message || null,
            actionId: response.actionid || response.ActionID || null,
        };
    }

    snapshot(call) {
        return {
            outbound_call_id: call.outboundCallId,
            action_id: call.actionId,
            external_call_id: call.linkedid || call.outboundCallId,
            linkedid: call.linkedid || null,
            uniqueid: call.uniqueid || null,
            channel: call.channel || null,
            status: call.status,
            direction: call.direction,
            client_source: "mobile",
            client_type: "mobile",
            ws_url: call.wsUrl || null,
            phone_number: call.phoneNumber,
            from_number: call.fromNumber || null,
            agent_id: call.agentId,
            device_id: call.deviceId,
            customer_id: call.customerId,
            tenant: call.tenant || null,
            mode: call.mode,
            cause_code: call.hangupCause || null,
            reason: call.hangupReason || null,
            created_at: call.createdAt,
            updated_at: call.updatedAt,
            answered_at: call.answeredAt,
            ended_at: call.endedAt,
            last_event: call.lastEvent,
            last_error: call.lastError,
        };
    }

    timestamp() {
        return this.now().toISOString();
    }
}

const mobileOutboundService = new MobileOutboundService();

module.exports = mobileOutboundService;
module.exports.MobileOutboundService = MobileOutboundService;

