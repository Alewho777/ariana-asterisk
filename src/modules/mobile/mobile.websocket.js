const WebSocket = require("ws");

const mobileMediaService = require("./mobile-media.service");

function attachMobileWebSocketServer(server) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url || "", "http://localhost");
        const match = url.pathname.match(/^\/api\/mobile\/calls\/([^/]+)\/agent-ws$/);

        if (!match) {
            return;
        }

        const linkedid = decodeURIComponent(match[1]);

        wss.handleUpgrade(request, socket, head, (ws) => {
            mobileMediaService.attachAgentWebSocket(linkedid, ws, {
                key: url.searchParams.get("key") || "",
                agentId: url.searchParams.get("agent_id") || null,
                clientType: url.searchParams.get("client_type") || "mobile",
            });
        });
    });
}

module.exports = {
    attachMobileWebSocketServer,
};

