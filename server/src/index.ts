import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SQLite } from "@hocuspocus/extension-sqlite";
import { Server } from "@hocuspocus/server";

import type { AiRuntimeOptions } from "./ai.js";
import { applyAccessToConnection, type AccessLevel } from "./auth.js";
import { createHttpApp } from "./http.js";
import { SignalingService } from "./signaling.js";
import { MetadataStore } from "./storage.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface InventoryServerOptions {
  ai?: AiRuntimeOptions;
  port?: number;
  dataDir?: string;
  staticDir?: string;
  quiet?: boolean;
  handleSignals?: boolean;
  logger?: Pick<Console, "info" | "error">;
}

export interface RunningInventoryServer {
  port: number;
  metadata: MetadataStore;
  signaling: SignalingService;
  close(): Promise<void>;
}

interface ConnectionContext {
  access?: AccessLevel;
}

function configuredPort(explicitPort: number | undefined): number {
  if (explicitPort !== undefined) {
    return explicitPort;
  }

  const value = process.env.PORT ?? "8787";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

export async function startInventoryServer(
  options: InventoryServerOptions = {},
): Promise<RunningInventoryServer> {
  const dataDir =
    options.dataDir ?? process.env.INVENTORY_DATA_DIR ?? join(SERVER_ROOT, "data");
  const staticDir =
    options.staticDir ?? resolve(SERVER_ROOT, "..", "app", "dist");
  const databasePath = join(dataDir, "docs.sqlite");
  const blobDir = join(dataDir, "blobs");
  const logger = options.logger ?? console;
  const port = configuredPort(options.port);

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(blobDir, { recursive: true });

  const metadata = new MetadataStore(databasePath);
  const signaling = new SignalingService();
  const sqlite = new SQLite({ database: databasePath });
  const app = createHttpApp({
    ai: { ...options.ai, logger: options.ai?.logger ?? logger },
    blobDir,
    metadata,
    serveStatic: existsSync(join(staticDir, "index.html")),
    staticDir,
  });

  const server = new Server<ConnectionContext>({
    port,
    address: "0.0.0.0",
    quiet: options.quiet ?? false,
    stopOnSignals: false,
    extensions: [sqlite],
    onUpgrade: async ({ request, socket, head }) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/signal") {
        // y-webrtc signaling rides on the same port; throwing (falsy) stops
        // Hocuspocus from also handling this upgrade.
        signaling.handleUpgrade(request, socket, head as Buffer);
        throw null;
      }
      if (pathname !== "/sync") {
        socket.destroy();
        throw null;
      }
    },
    onRequest: async ({ request, response }) => {
      app(request, response);
      // Stop Hocuspocus's built-in HTTP welcome response. Express owns HTTP.
      throw null;
    },
    onAuthenticate: async ({
      documentName,
      token,
      connectionConfig,
    }) => {
      const level = metadata.authenticateAndStore(documentName, token);
      logger.info(
        `[auth] docId=${JSON.stringify(documentName)} level=${level ?? "reject"}`,
      );
      if (!level) {
        throw { code: 4403, reason: "Forbidden" };
      }

      applyAccessToConnection(level, connectionConfig);
      return { access: level };
    },
  });

  await server.listen();

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
      signaling.close();
      await server.destroy();
      sqlite.db?.close();
      metadata.close();
    })();
    return closePromise;
  };
  const signalHandler = () => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(error);
        process.exit(1);
      });
  };

  if (options.handleSignals) {
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
  }

  return {
    port: server.address.port,
    metadata,
    signaling,
    close,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  startInventoryServer({ handleSignals: true })
    .then(({ port }) => {
      console.info(`Inventory server listening on port ${port}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
