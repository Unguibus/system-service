import type { Message } from "./types";
import { deliverFromExchange, setCrossHostSender } from "./messages";

let eventSource: ReadableStreamDefaultReader | null = null;
let connected = false;
let hostId: string = "";
let exchangeUrl: string = "";
let exchangeSecret: string = "";
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastTimestamp = 0;

export function getHostId(): string {
  return hostId;
}

export function isExchangeConnected(): boolean {
  return connected;
}

export async function connectToExchange(config: {
  url: string;
  secret: string;
  hostId: string;
}): Promise<void> {
  exchangeUrl = config.url;
  exchangeSecret = config.secret;
  hostId = config.hostId;

  // Set up the cross-host sender
  setCrossHostSender(async (msg: Message) => {
    try {
      await fetch(`${exchangeUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${exchangeSecret}`,
        },
        body: JSON.stringify(msg),
      });
    } catch (err: any) {
      console.error(`[exchange] Failed to send cross-host message: ${err.message}`);
    }
  });

  await subscribe();
}

async function subscribe(): Promise<void> {
  const url = `${exchangeUrl}/events?hostId=${hostId}${
    lastTimestamp ? `&since=${lastTimestamp}` : ""
  }`;

  console.log(`[exchange] Connecting to ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${exchangeSecret}`,
        Accept: "text/event-stream",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    connected = true;
    console.log(`[exchange] Connected as host ${hostId}`);

    const reader = response.body!.getReader();
    eventSource = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const msg: Message = JSON.parse(line.slice(6));
            lastTimestamp = Math.max(lastTimestamp, msg.timestamp);
            deliverFromExchange(msg);
          } catch {}
        }
        // Ignore heartbeat comments
      }
    }
  } catch (err: any) {
    console.error(`[exchange] Connection error: ${err.message}`);
  } finally {
    connected = false;
    eventSource = null;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  console.log("[exchange] Reconnecting in 5s...");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    subscribe();
  }, 5000);
}

export function disconnectFromExchange(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.cancel();
    eventSource = null;
  }
  connected = false;
  console.log("[exchange] Disconnected");
}
