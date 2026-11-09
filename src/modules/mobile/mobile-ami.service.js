const AsteriskManager = require("asterisk-manager");
const env = require("../../config/env");

let amiClient = null;

function getAmiClient() {
    if (amiClient) {
        return amiClient;
    }

    if (!env.pbxAmiHost || !env.pbxAmiUsername || !env.pbxAmiPassword) {
        console.warn("[mobile:ami] AMI credentials are missing in env");
        return null;
    }

    try {
        amiClient = new AsteriskManager(
            env.pbxAmiPort,
            env.pbxAmiHost,
            env.pbxAmiUsername,
            env.pbxAmiPassword,
            env.pbxAmiReconnect !== false
        );

        amiClient.keepConnected();

        amiClient.on("connect", () => {
            console.log(`[mobile:ami] Connected to Asterisk AMI at ${env.pbxAmiHost}:${env.pbxAmiPort}`);
        });

        amiClient.on("disconnect", () => {
            console.warn("[mobile:ami] Disconnected from Asterisk AMI");
        });

        amiClient.on("error", (err) => {
            console.warn("[mobile:ami] AMI error:", err.message);
        });
    } catch (error) {
        console.error("[mobile:ami] Failed to initialize AsteriskManager:", error.message);
    }

    return amiClient;
}

const ami = {
    action(actionPayload) {
        return new Promise((resolve, reject) => {
            const client = getAmiClient();
            if (!client) {
                return reject(new Error("Asterisk AMI is not configured or not available"));
            }

            client.action(actionPayload, (err, res) => {
                if (err) {
                    return reject(err);
                }
                return resolve(res);
            });
        });
    },
    __test: {
        setAmi(mockAmi) {
            amiClient = mockAmi;
        },
        resetAmi() {
            if (amiClient && typeof amiClient.disconnect === "function") {
                try {
                    amiClient.disconnect();
                } catch (_) {}
            }
            amiClient = null;
        },
    },
};

module.exports = ami;

