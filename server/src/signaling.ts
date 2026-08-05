/**
 * y-webrtc signaling endpoint (`/signal`), mounted on the same HTTP server as
 * Hocuspocus (see index.ts onUpgrade). Speaks y-webrtc's trivial pub/sub
 * protocol: JSON messages { type: subscribe|unsubscribe, topics: [..] },
 * { type: publish, topic }, { type: ping }.
 *
 * Privacy model (see CONTRACTS.md "Direct device-to-device sync"):
 * clients derive topic names by HMAC-ing the docId with the E2E content key,
 * so this server only ever sees unguessable room ids, peer IP addresses and
 * (password-)encrypted SDP payloads. It learns nothing about doc ids or
 * content, and strangers cannot subscribe to a doc's room without the key.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

const PING_INTERVAL_MS = 30_000;
/** Cap topics per connection so a client cannot balloon server memory. */
const MAX_TOPICS_PER_CONN = 256;
const MAX_MESSAGE_BYTES = 64 * 1024;

interface SignalingMessage {
  type?: string;
  topics?: unknown;
  topic?: unknown;
  clients?: number;
}

export class SignalingService {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  private readonly topics = new Map<string, Set<WebSocket>>();

  constructor() {
    this.wss.on("connection", (conn: WebSocket) => this.setupConnection(conn));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (conn) => {
      this.wss.emit("connection", conn, request);
    });
  }

  /** Number of live rooms (for tests/inspection). */
  get topicCount(): number {
    return this.topics.size;
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.wss.close();
    this.topics.clear();
  }

  private send(conn: WebSocket, message: object): void {
    if (conn.readyState !== conn.CONNECTING && conn.readyState !== conn.OPEN) {
      conn.close();
      return;
    }
    try {
      conn.send(JSON.stringify(message));
    } catch {
      conn.close();
    }
  }

  private setupConnection(conn: WebSocket): void {
    const subscribed = new Set<string>();
    let closed = false;

    let pongReceived = true;
    const pingInterval = setInterval(() => {
      if (!pongReceived) {
        conn.close();
        clearInterval(pingInterval);
        return;
      }
      pongReceived = false;
      try {
        conn.ping();
      } catch {
        conn.close();
      }
    }, PING_INTERVAL_MS);
    conn.on("pong", () => {
      pongReceived = true;
    });

    conn.on("close", () => {
      for (const topicName of subscribed) {
        const subs = this.topics.get(topicName);
        if (subs) {
          subs.delete(conn);
          if (subs.size === 0) {
            this.topics.delete(topicName);
          }
        }
      }
      subscribed.clear();
      closed = true;
      clearInterval(pingInterval);
    });

    conn.on("message", (raw) => {
      if (closed) {
        return;
      }
      let message: SignalingMessage;
      try {
        message = JSON.parse(raw.toString()) as SignalingMessage;
      } catch {
        return;
      }
      if (!message || typeof message.type !== "string") {
        return;
      }

      switch (message.type) {
        case "subscribe": {
          for (const topicName of asTopicList(message.topics)) {
            if (subscribed.size >= MAX_TOPICS_PER_CONN) {
              break;
            }
            let subs = this.topics.get(topicName);
            if (!subs) {
              subs = new Set();
              this.topics.set(topicName, subs);
            }
            subs.add(conn);
            subscribed.add(topicName);
          }
          break;
        }
        case "unsubscribe": {
          for (const topicName of asTopicList(message.topics)) {
            const subs = this.topics.get(topicName);
            if (subs) {
              subs.delete(conn);
              if (subs.size === 0) {
                this.topics.delete(topicName);
              }
            }
            subscribed.delete(topicName);
          }
          break;
        }
        case "publish": {
          if (typeof message.topic !== "string") {
            break;
          }
          const receivers = this.topics.get(message.topic);
          if (receivers) {
            message.clients = receivers.size;
            for (const receiver of receivers) {
              this.send(receiver, message);
            }
          }
          break;
        }
        case "ping": {
          this.send(conn, { type: "pong" });
          break;
        }
      }
    });
  }
}

function asTopicList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (topic): topic is string => typeof topic === "string" && topic.length <= 512,
  );
}
