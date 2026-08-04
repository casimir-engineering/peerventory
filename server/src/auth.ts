import { createHash, timingSafeEqual } from "node:crypto";

export type AccessLevel = "rw" | "ro";

export interface DocMeta {
  rwHash: string;
  roHash: string;
}

export interface AuthDecision {
  level: AccessLevel;
  createMeta?: DocMeta;
}

interface TokenPayload {
  t: string;
  create?: DocMeta;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesMatch(actual: string, expected: string): boolean {
  if (!SHA256_HEX.test(expected)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function parseTokenPayload(tokenJson: string): TokenPayload | null {
  try {
    const value: unknown = JSON.parse(tokenJson);
    if (typeof value !== "object" || value === null || !("t" in value)) {
      return null;
    }

    const token = (value as { t?: unknown }).t;
    if (typeof token !== "string") {
      return null;
    }

    const rawCreate = (value as { create?: unknown }).create;
    if (rawCreate === undefined) {
      return { t: token };
    }
    if (typeof rawCreate !== "object" || rawCreate === null) {
      return null;
    }

    const { rwHash, roHash } = rawCreate as {
      rwHash?: unknown;
      roHash?: unknown;
    };
    if (
      typeof rwHash !== "string" ||
      typeof roHash !== "string" ||
      !SHA256_HEX.test(rwHash) ||
      !SHA256_HEX.test(roHash)
    ) {
      return null;
    }

    return { t: token, create: { rwHash, roHash } };
  } catch {
    return null;
  }
}

export function authenticateDoc(
  meta: DocMeta | null,
  tokenJson: string,
): AuthDecision | null {
  const payload = parseTokenPayload(tokenJson);
  if (!payload) {
    return null;
  }

  const tokenHash = sha256Hex(payload.t);
  if (meta) {
    if (hashesMatch(tokenHash, meta.rwHash)) {
      return { level: "rw" };
    }
    if (hashesMatch(tokenHash, meta.roHash)) {
      return { level: "ro" };
    }
    return null;
  }

  if (payload.create && hashesMatch(tokenHash, payload.create.rwHash)) {
    return { level: "rw", createMeta: payload.create };
  }

  return null;
}

export function applyAccessToConnection(
  level: AccessLevel,
  connectionConfig: { readOnly: boolean },
): void {
  connectionConfig.readOnly = level === "ro";
}
