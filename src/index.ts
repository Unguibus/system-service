import { mkdirSync } from "fs";
import { UNGUIBUS_HOME, AGENTS_DIR } from "./types";
import { discoverAgents } from "./agents";
import { initIAM } from "./iam";
import { startServer } from "./server";
import { initMessageDb, startCleanupTimer } from "./conversation-db";

// Ensure required directories exist
mkdirSync(AGENTS_DIR, { recursive: true });

console.log("[init] unguibus system-service starting...");
console.log(`[init] Home: ${UNGUIBUS_HOME}`);

// Initialize databases
initIAM();
initMessageDb();

// Discover existing agents from filesystem and start them
discoverAgents();

// Start HTTP server
startServer();

// Start conversation TTL cleanup
startCleanupTimer();

// Connect to Exchange if configured
const exchangeUrl = process.env.EXCHANGE_URL;
const exchangeSecret = process.env.EXCHANGE_SECRET;
const hostId = process.env.HOST_ID;

if (exchangeUrl && exchangeSecret && hostId) {
  import("./exchange-client").then(({ connectToExchange }) => {
    connectToExchange({ url: exchangeUrl, secret: exchangeSecret, hostId });
  });
} else {
  console.log("[init] No Exchange configured (set EXCHANGE_URL, EXCHANGE_SECRET, HOST_ID)");
}

console.log("[init] System service ready.");
console.log("[init] Endpoints:");
console.log("  POST /messages          — Send a message");
console.log("  GET  /agents            — List agents");
console.log("  POST /agents            — Create agent");
console.log("  GET  /health            — Health check");
console.log("  POST /exchange/connect  — Connect to Exchange");
