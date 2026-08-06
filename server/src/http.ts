import { createReadStream } from "node:fs";
import {
  access,
  link,
  mkdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import {
  createAiAnalyzeHandler,
  type AiRuntimeOptions,
} from "./ai.js";
import { authenticateDoc, sha256Hex, type AccessLevel } from "./auth.js";
import { deleteDocData } from "./gc.js";
import type { MetadataStore } from "./storage.js";

export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface HttpAppOptions {
  ai?: AiRuntimeOptions;
  blobDir: string;
  staticDir: string;
  metadata: MetadataStore;
  serveStatic: boolean;
  /** Called when a doc is explicitly deleted (closes live sync connections). */
  onDocDeleted?: (docId: string) => void;
}

function setCorsHeaders(response: Response): void {
  response.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-token, content-type",
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, HEAD, OPTIONS",
  });
}

function getToken(request: Request): string | null {
  const token = request.header("x-token");
  return token && token.length > 0 ? token : null;
}

function authorizeHttp(
  metadata: MetadataStore,
  docId: string,
  token: string,
): AccessLevel | null {
  const meta = metadata.getDocMeta(docId);
  return meta
    ? (authenticateDoc(meta, JSON.stringify({ t: token }))?.level ?? null)
    : null;
}

function requireAccess(
  request: Request,
  response: Response,
  metadata: MetadataStore,
  docId: string,
  required: "rw" | "any",
): AccessLevel | null {
  const token = getToken(request);
  if (!token) {
    response.sendStatus(401);
    return null;
  }

  const accessLevel = authorizeHttp(metadata, docId, token);
  if (!accessLevel || (required === "rw" && accessLevel !== "rw")) {
    response.sendStatus(403);
    return null;
  }

  // Any authenticated blob access renews the doc's GC lease (see gc.ts).
  metadata.touchDoc(docId);
  return accessLevel;
}

function cleanMime(value: string | undefined): string {
  const mime = value?.split(";", 1)[0]?.trim();
  return mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
}

async function storeBlobAtomically(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, body, { flag: "wx" });
  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function createHttpApp(options: HttpAppOptions): express.Express {
  const app = express();
  const { ai, blobDir, metadata, onDocDeleted, serveStatic, staticDir } = options;
  const rawBlobBody = express.raw({
    limit: MAX_BLOB_BYTES,
    type: () => true,
  });
  const aiJsonBody = express.json({ limit: "9mb" });

  app.use("/api", (_request, response, next) => {
    setCorsHeaders(response);
    next();
  });

  app.options("/api/{*path}", (_request, response) => {
    response.sendStatus(204);
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post(
    "/api/ai/analyze",
    aiJsonBody,
    createAiAnalyzeHandler(metadata, ai),
  );

  app.put(
    "/api/blobs/:docId/:hash",
    rawBlobBody,
    async (request, response) => {
      const { docId, hash } = request.params;
      if (!SHA256_HEX.test(hash)) {
        response.status(400).json({ error: "Invalid blob hash" });
        return;
      }
      if (!requireAccess(request, response, metadata, docId, "rw")) {
        return;
      }

      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      if (sha256Hex(body) !== hash) {
        response.status(400).json({ error: "Blob hash mismatch" });
        return;
      }

      const path = join(blobDir, hash.slice(0, 2), hash);
      await storeBlobAtomically(path, body);
      metadata.recordBlobReference(
        docId,
        hash,
        cleanMime(request.header("content-type")),
      );
      response.sendStatus(204);
    },
  );

  const sendBlob = async (request: Request, response: Response) => {
    const docId = String(request.params.docId);
    const hash = String(request.params.hash);
    if (!SHA256_HEX.test(hash)) {
      response.sendStatus(404);
      return;
    }
    if (!requireAccess(request, response, metadata, docId, "any")) {
      return;
    }

    const reference = metadata.getBlobReference(docId, hash);
    if (!reference) {
      response.sendStatus(404);
      return;
    }

    const path = join(blobDir, hash.slice(0, 2), hash);
    try {
      await access(path);
      const details = await stat(path);
      response.set({
        "Content-Type": reference.mime,
        "Content-Length": String(details.size),
      });
      if (request.method === "HEAD") {
        response.status(200).end();
        return;
      }

      createReadStream(path)
        .on("error", () => {
          if (!response.headersSent) {
            response.sendStatus(404);
          } else {
            response.destroy();
          }
        })
        .pipe(response);
    } catch {
      response.sendStatus(404);
    }
  };

  app.get("/api/blobs/:docId/:hash", sendBlob);
  app.head("/api/blobs/:docId/:hash", sendBlob);

  // Explicit immediate deletion (the lease sweep in gc.ts is the fallback):
  // an rw-token holder removes the doc's Yjs state, token record and blobs.
  // Idempotent — deleting an unknown doc succeeds with 204, so a retry after
  // a success (whose token record is gone) does not turn into an error.
  app.delete("/api/docs/:docId", async (request, response) => {
    const docId = String(request.params.docId);
    const token = getToken(request);
    if (!token) {
      response.sendStatus(401);
      return;
    }
    const meta = metadata.getDocMeta(docId);
    if (meta) {
      const level = authenticateDoc(meta, JSON.stringify({ t: token }))?.level;
      if (level !== "rw") {
        response.sendStatus(403);
        return;
      }
      // Close live sync connections first so Hocuspocus stops serving the
      // doc; a debounced store racing this delete leaves at most an inert
      // orphan row (no token record), which the next sweep removes.
      onDocDeleted?.(docId);
      await deleteDocData(metadata, blobDir, docId);
      console.info("[gc] doc deleted on request");
    }
    response.sendStatus(204);
  });

  app.use("/api", (_request, response) => {
    response.sendStatus(404);
  });

  if (serveStatic) {
    app.use(express.static(staticDir));
    app.use((request, response, next) => {
      if (
        request.method !== "GET" ||
        request.path.startsWith("/api") ||
        request.path.startsWith("/sync")
      ) {
        next();
        return;
      }
      response.sendFile(join(staticDir, "index.html"));
    });
  }

  app.use((_request, response) => {
    response.sendStatus(404);
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      if (request.path === "/api/ai/analyze") {
        (ai?.logger ?? console).info(
          '[ai] docId="unknown" photos=0 outcome=invalid-request',
        );
        response.status(413).json({ error: "invalid-request" });
        return;
      }
      response.status(413).json({ error: "Blob exceeds 10 MB limit" });
      return;
    }

    if (
      request.path === "/api/ai/analyze" &&
      error instanceof SyntaxError &&
      "body" in error
    ) {
      (ai?.logger ?? console).info(
        '[ai] docId="unknown" photos=0 outcome=invalid-request',
      );
      response.status(400).json({ error: "invalid-request" });
      return;
    }

    console.error(error);
    response.sendStatus(500);
  };
  app.use(errorHandler);

  return app;
}
