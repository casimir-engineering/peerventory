import type { Request, RequestHandler, Response } from "express";

import { authenticateDoc } from "./auth.js";
import type { MetadataStore } from "./storage.js";

export const MAX_AI_PHOTOS = 3;
export const MAX_AI_PHOTO_BYTES = 2 * 1024 * 1024;
export const AI_RATE_LIMIT = 5;
export const AI_RATE_WINDOW_MS = 60_000;
export const AI_TIMEOUT_MS = 30_000;
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface AiPhoto {
  mime: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
}

export interface AiAnalyzeRequest {
  docId: string;
  photos: AiPhoto[];
  context: {
    description?: string;
    mainCurrency?: string;
  };
}

export interface AiSuggestions {
  description?: string;
  category?: string;
  tags?: string[];
  brandModel?: string;
  valueCurrent?: { amount: number; currency: string };
  valueNew?: { amount: number; currency: string };
  weightGrams?: number;
  dimensionsMm?: { l: number; w: number; h: number };
  lithiumBattery?: boolean;
  countryOfOrigin?: string;
  hsCode?: string;
  condition?: string;
  translations?: { zh: string };
}

export type AiValidationResult =
  | { ok: true; value: AiAnalyzeRequest }
  | { ok: false };

export interface AiRuntimeOptions {
  fetchImpl?: typeof fetch;
  getApiKey?: () => string | undefined;
  getModel?: () => string | undefined;
  logger?: Pick<Console, "info" | "error">;
  now?: () => number;
  rateLimiter?: RollingRateLimiter;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodedBase64Bytes(value: string): number | null {
  if (value.length === 0 || !BASE64.test(value)) {
    return null;
  }
  return Buffer.from(value, "base64").byteLength;
}

export function validateAiAnalyzeRequest(body: unknown): AiValidationResult {
  if (!isRecord(body)) {
    return { ok: false };
  }

  const { docId, photos, context } = body;
  if (
    typeof docId !== "string" ||
    docId.length === 0 ||
    docId.length > 256 ||
    !Array.isArray(photos) ||
    photos.length < 1 ||
    photos.length > MAX_AI_PHOTOS ||
    !isRecord(context)
  ) {
    return { ok: false };
  }

  const validatedPhotos: AiPhoto[] = [];
  for (const photo of photos) {
    if (
      !isRecord(photo) ||
      typeof photo.mime !== "string" ||
      !ALLOWED_MIMES.has(photo.mime) ||
      typeof photo.dataBase64 !== "string"
    ) {
      return { ok: false };
    }
    const byteLength = decodedBase64Bytes(photo.dataBase64);
    if (byteLength === null || byteLength > MAX_AI_PHOTO_BYTES) {
      return { ok: false };
    }
    validatedPhotos.push(photo as unknown as AiPhoto);
  }

  const validatedContext: AiAnalyzeRequest["context"] = {};
  if (context.description !== undefined) {
    if (typeof context.description !== "string") {
      return { ok: false };
    }
    validatedContext.description = context.description;
  }
  if (context.mainCurrency !== undefined) {
    if (typeof context.mainCurrency !== "string") {
      return { ok: false };
    }
    validatedContext.mainCurrency = context.mainCurrency;
  }

  return {
    ok: true,
    value: {
      docId,
      photos: validatedPhotos,
      context: validatedContext,
    },
  };
}

export class RollingRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly limit = AI_RATE_LIMIT,
    private readonly windowMs = AI_RATE_WINDOW_MS,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.requests.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= this.limit) {
      this.requests.set(key, recent);
      return false;
    }

    recent.push(now);
    this.requests.set(key, recent);
    return true;
  }
}

function cleanOptionalFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseMoney(value: unknown): { amount: number; currency: string } | null {
  if (
    !isRecord(value) ||
    !finiteNumber(value.amount) ||
    typeof value.currency !== "string"
  ) {
    return null;
  }
  return { amount: value.amount, currency: value.currency };
}

export function parseAiSuggestions(text: string): AiSuggestions {
  const parsed: unknown = JSON.parse(cleanOptionalFence(text));
  if (!isRecord(parsed)) {
    throw new Error("AI reply must be a JSON object");
  }

  const suggestions: AiSuggestions = {};
  const stringKeys = [
    "description",
    "category",
    "brandModel",
    "countryOfOrigin",
    "condition",
  ] as const;
  for (const key of stringKeys) {
    if (typeof parsed[key] === "string") {
      suggestions[key] = parsed[key];
    }
  }

  if (Array.isArray(parsed.tags)) {
    suggestions.tags = parsed.tags.filter(
      (tag): tag is string => typeof tag === "string",
    );
  }

  const valueCurrent = parseMoney(parsed.valueCurrent);
  if (valueCurrent) {
    suggestions.valueCurrent = valueCurrent;
  }
  const valueNew = parseMoney(parsed.valueNew);
  if (valueNew) {
    suggestions.valueNew = valueNew;
  }

  if (finiteNumber(parsed.weightGrams) && Number.isInteger(parsed.weightGrams)) {
    suggestions.weightGrams = parsed.weightGrams;
  }
  if (
    isRecord(parsed.dimensionsMm) &&
    finiteNumber(parsed.dimensionsMm.l) &&
    Number.isInteger(parsed.dimensionsMm.l) &&
    finiteNumber(parsed.dimensionsMm.w) &&
    Number.isInteger(parsed.dimensionsMm.w) &&
    finiteNumber(parsed.dimensionsMm.h) &&
    Number.isInteger(parsed.dimensionsMm.h)
  ) {
    suggestions.dimensionsMm = {
      l: parsed.dimensionsMm.l,
      w: parsed.dimensionsMm.w,
      h: parsed.dimensionsMm.h,
    };
  }
  if (typeof parsed.lithiumBattery === "boolean") {
    suggestions.lithiumBattery = parsed.lithiumBattery;
  }
  if (typeof parsed.hsCode === "string" && /^\d{6}$/.test(parsed.hsCode)) {
    suggestions.hsCode = parsed.hsCode;
  }
  if (
    isRecord(parsed.translations) &&
    typeof parsed.translations.zh === "string"
  ) {
    suggestions.translations = { zh: parsed.translations.zh };
  }

  return suggestions;
}

function buildPrompt(context: AiAnalyzeRequest["context"]): string {
  const suppliedContext: string[] = [];
  if (context.description) {
    suppliedContext.push(
      `Existing description: ${JSON.stringify(context.description)}`,
    );
  }
  if (context.mainCurrency) {
    suppliedContext.push(`Main currency: ${JSON.stringify(context.mainCurrency)}`);
  }

  return [
    "Analyze the pictured inventory item for an app that prepares customs manifests when people ship personal effects and electronics internationally.",
    ...suppliedContext,
    "Return STRICT JSON only: no prose and no markdown fences.",
    "Use only these optional keys: description (short, customs-suitable English), category, tags (array of strings), brandModel, valueCurrent {amount, currency}, valueNew {amount, currency}, weightGrams (integer), dimensionsMm {l,w,h} (integers), lithiumBattery (boolean), countryOfOrigin (as marked or likely), hsCode (6-digit HS code as a string), condition (short), translations {zh: description translated to zh-CN}.",
    context.mainCurrency
      ? "Estimate realistic used and new values in the supplied main currency."
      : "Estimate realistic used and new values, using an appropriate currency.",
    "Omit any field you cannot estimate responsibly. Do not add any other keys.",
  ].join("\n");
}

function anthropicRequestBody(request: AiAnalyzeRequest, model: string): object {
  return {
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          ...request.photos.map((photo) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: photo.mime,
              data: photo.dataBase64,
            },
          })),
          { type: "text", text: buildPrompt(request.context) },
        ],
      },
    ],
  };
}

function extractReplyText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error("Anthropic response did not contain content");
  }
  const text = payload.content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("\n");
  if (text.length === 0) {
    throw new Error("Anthropic response did not contain text");
  }
  return text;
}

function redactUpstreamBody(body: string): string {
  return body
    .replace(/[A-Za-z0-9+/=]{128,}/g, "[redacted-long-data]")
    .slice(0, 4_000);
}

function requestIdentity(body: unknown): { docId: string; photoCount: number } {
  if (!isRecord(body)) {
    return { docId: "unknown", photoCount: 0 };
  }
  return {
    docId: typeof body.docId === "string" ? body.docId : "unknown",
    photoCount: Array.isArray(body.photos) ? body.photos.length : 0,
  };
}

function logRequest(
  logger: Pick<Console, "info" | "error">,
  identity: { docId: string; photoCount: number },
  outcome: string,
  errorDetail?: string,
): void {
  const line =
    `[ai] docId=${JSON.stringify(identity.docId)}` +
    ` photos=${identity.photoCount} outcome=${outcome}` +
    (errorDetail ? ` ${errorDetail}` : "");
  if (errorDetail) {
    logger.error(line);
  } else {
    logger.info(line);
  }
}

function authorizeRw(
  request: Request,
  response: Response,
  metadata: MetadataStore,
  docId: string,
): boolean {
  const token = request.header("x-token");
  if (!token) {
    response.sendStatus(401);
    return false;
  }
  const meta = metadata.getDocMeta(docId);
  const level = meta
    ? authenticateDoc(meta, JSON.stringify({ t: token }))?.level
    : null;
  if (level !== "rw") {
    response.sendStatus(403);
    return false;
  }
  return true;
}

export function createAiAnalyzeHandler(
  metadata: MetadataStore,
  options: AiRuntimeOptions = {},
): RequestHandler {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const getApiKey = options.getApiKey ?? (() => process.env.ANTHROPIC_API_KEY);
  const getModel =
    options.getModel ??
    (() => process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL);
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const rateLimiter = options.rateLimiter ?? new RollingRateLimiter();
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;

  return async (request, response) => {
    const identity = requestIdentity(request.body);
    if (identity.docId === "unknown") {
      logRequest(logger, identity, "invalid-request");
      response.status(400).json({ error: "invalid-request" });
      return;
    }
    if (!authorizeRw(request, response, metadata, identity.docId)) {
      logRequest(
        logger,
        identity,
        request.header("x-token") ? "forbidden" : "unauthorized",
      );
      return;
    }

    const validation = validateAiAnalyzeRequest(request.body);
    if (!validation.ok) {
      logRequest(logger, identity, "invalid-request");
      response.status(400).json({ error: "invalid-request" });
      return;
    }
    const apiKey = getApiKey();
    if (!apiKey) {
      logRequest(logger, identity, "ai-not-configured");
      response.status(503).json({ error: "ai-not-configured" });
      return;
    }
    if (!rateLimiter.allow(validation.value.docId, now())) {
      logRequest(logger, identity, "rate-limited");
      response.status(429).json({ error: "rate-limited" });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          anthropicRequestBody(
            validation.value,
            getModel() ?? DEFAULT_ANTHROPIC_MODEL,
          ),
        ),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const upstreamBody = await upstream.text();
        logRequest(
          logger,
          identity,
          "ai-upstream",
          `status=${upstream.status} body=${JSON.stringify(redactUpstreamBody(upstreamBody))}`,
        );
        response
          .status(502)
          .json({ error: "ai-upstream", detail: upstream.status });
        return;
      }

      const upstreamBody = await upstream.text();
      const payload: unknown = JSON.parse(upstreamBody);
      const suggestions = parseAiSuggestions(extractReplyText(payload));
      logRequest(logger, identity, "ok");
      response.json({ suggestions });
    } catch (error) {
      if (controller.signal.aborted) {
        logRequest(logger, identity, "timeout");
        response.status(504).json({ error: "ai-timeout" });
        return;
      }
      logRequest(
        logger,
        identity,
        "ai-upstream",
        `invalid-response=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
      response.status(502).json({ error: "ai-upstream" });
    } finally {
      clearTimeout(timeout);
    }
  };
}
