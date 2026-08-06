import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SQLite } from "@hocuspocus/extension-sqlite";
import { Server } from "@hocuspocus/server";

import type { AiRuntimeOptions } from "./ai.js";
import { applyAccessToConnection, type AccessLevel } from "./auth.js";
import { sweepStaleDocs, type SweepResult } from "./gc.js";
import { createHttpApp } from "./http.js";
import { SignalingService } from "./signaling.js";
import { MetadataStore } from "./storage.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 180;
/** First sweep shortly after boot (lets the deploy log confirm the pass). */
const SWEEP_STARTUP_DELAY_MS = 60_000;

export interface InventoryServerOptions {
  ai?: AiRuntimeOptions;
  port?: number;
  dataDir?: string;
  staticDir?: string;
  quiet?: boolean;
  handleSignals?: boolean;
  logger?: Pick<Console, "info" | "error">;
  /**
   * Lease retention window for the GC sweep (see gc.ts); 0 disables
   * garbage collection entirely. Defaults to env RETENTION_DAYS, then 180.
   */
  retentionDays?: number;
}

export interface RunningInventoryServer {
  port: number;
  metadata: MetadataStore;
  signaling: SignalingService;
  /** Run one GC pass now (tests / operator tooling). */
  sweep(now?: number): Promise<SweepResult>;
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

function configuredRetentionDays(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit;
  }

  const value = process.env.RETENTION_DAYS;
  if (value === undefined || value === "") {
    return DEFAULT_RETENTION_DAYS;
  }
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`Invalid RETENTION_DAYS: ${value}`);
  }
  return days;
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
  const retentionDays = configuredRetentionDays(options.retentionDays);
  const closeDocConnections = (docId: string): void => {
    try {
      server.hocuspocus.closeConnections(docId);
    } catch {
      // server still starting up or already shut down — nothing to close
    }
  };
  const app = createHttpApp({
    ai: { ...options.ai, logger: options.ai?.logger ?? logger },
    blobDir,
    metadata,
    onDocDeleted: closeDocConnections,
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

      // Any authenticated sync connection renews the doc's GC lease.
      metadata.touchDoc(documentName);
      applyAccessToConnection(level, connectionConfig);
      return { access: level };
    },
  });

  await server.listen();

  const sweep = (now?: number): Promise<SweepResult> =>
    sweepStaleDocs({
      metadata,
      blobDir,
      retentionMs: retentionDays * DAY_MS,
      now,
      logger,
      onDocDeleted: closeDocConnections,
    });

  let sweepStartupTimer: NodeJS.Timeout | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  if (retentionDays > 0) {
    logger.info(`[gc] lease retention: ${retentionDays} days, daily sweep`);
    const run = () => {
      sweep().catch((error: unknown) => logger.error("[gc] sweep failed", error));
    };
    sweepStartupTimer = setTimeout(run, SWEEP_STARTUP_DELAY_MS);
    sweepStartupTimer.unref?.();
    sweepTimer = setInterval(run, DAY_MS);
    sweepTimer.unref?.();
  } else {
    logger.info("[gc] disabled (RETENTION_DAYS=0)");
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
      clearTimeout(sweepStartupTimer);
      clearInterval(sweepTimer);
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
    sweep,
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
