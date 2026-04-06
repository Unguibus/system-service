import { mkdirSync } from "fs";
import { UNGUIBUS_HOME, UNASSIGNED_DIR, OFFBOARDED_DIR } from "./types";
import { discoverAgents } from "./agents";
import { startServer } from "./server";

// Ensure required directories exist
mkdirSync(UNASSIGNED_DIR, { recursive: true });
mkdirSync(OFFBOARDED_DIR, { recursive: true });

console.log("[init] unguibus system-service starting...");
console.log(`[init] Home: ${UNGUIBUS_HOME}`);

// Discover existing agents from filesystem
discoverAgents();

// Start HTTP server
startServer();

console.log("[init] System service ready.");
