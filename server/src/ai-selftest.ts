import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_AI_PHOTO_BYTES,
  RollingRateLimiter,
  parseAiSuggestions,
  validateAiAnalyzeRequest,
} from "./ai.js";
import { sha256Hex, type DocMeta } from "./auth.js";
import { startInventoryServer } from "./index.js";

const VALID_BODY = {
  docId: "testDoc001",
  photos: [{ mime: "image/jpeg", dataBase64: Buffer.from("photo").toString("base64") }],
  context: { description: "Used laptop", mainCurrency: "USD" },
};

async function expectStatus(
  responsePromise: Promise<Response>,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  assert.equal(
    response.status,
    expected,
    `${label}: expected ${expected}, received ${response.status}`,
  );
  return response;
}

function testValidation(): void {
  const valid = validateAiAnalyzeRequest(VALID_BODY);
  assert.equal(valid.ok, true);

  assert.equal(
    validateAiAnalyzeRequest({ ...VALID_BODY, photos: [] }).ok,
    false,
  );
  assert.equal(
    validateAiAnalyzeRequest({
      ...VALID_BODY,
      photos: Array.from({ length: 4 }, () => VALID_BODY.photos[0]),
    }).ok,
    false,
  );
  assert.equal(
    validateAiAnalyzeRequest({
      ...VALID_BODY,
      photos: [{ mime: "image/gif", dataBase64: "YWJj" }],
    }).ok,
    false,
  );
  assert.equal(
    validateAiAnalyzeRequest({
      ...VALID_BODY,
      photos: [
        {
          mime: "image/png",
          dataBase64: Buffer.alloc(MAX_AI_PHOTO_BYTES + 1).toString("base64"),
        },
      ],
    }).ok,
    false,
  );
  assert.equal(
    validateAiAnalyzeRequest({
      ...VALID_BODY,
      photos: [{ mime: "image/webp", dataBase64: "not base64!" }],
    }).ok,
    false,
  );
  assert.equal(
    validateAiAnalyzeRequest({
      ...VALID_BODY,
      context: { mainCurrency: 123 },
    }).ok,
    false,
  );
  console.info("ok - AI request validation");
}

function testRateLimiter(): void {
  const limiter = new RollingRateLimiter();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.allow("doc-a", index), true);
  }
  assert.equal(limiter.allow("doc-a", 5), false);
  assert.equal(limiter.allow("doc-b", 5), true);
  assert.equal(limiter.allow("doc-a", 60_000), true);
  console.info("ok - rolling per-document rate limiter");
}

function testReplyParsing(): void {
  const suggestions = parseAiSuggestions(`
    \`\`\`json
    {
      "description": "Used notebook computer",
      "category": 123,
      "tags": ["electronics", 7, "computer"],
      "brandModel": "ExampleBook 14",
      "valueCurrent": {"amount": 350, "currency": "USD", "extra": true},
      "valueNew": {"amount": "900", "currency": "USD"},
      "weightGrams": "1400",
      "dimensionsMm": {"l": 320, "w": 220, "h": 18},
      "lithiumBattery": true,
      "countryOfOrigin": "Germany",
      "hsCode": "847130",
      "condition": "Used, good",
      "translations": {"zh": "二手笔记本电脑", "fr": "ordinateur"},
      "unknown": "drop me"
    }
    \`\`\`
  `);
  assert.deepEqual(suggestions, {
    description: "Used notebook computer",
    tags: ["electronics", "computer"],
    brandModel: "ExampleBook 14",
    valueCurrent: { amount: 350, currency: "USD" },
    dimensionsMm: { l: 320, w: 220, h: 18 },
    lithiumBattery: true,
    countryOfOrigin: "Germany",
    hsCode: "847130",
    condition: "Used, good",
    translations: { zh: "二手笔记本电脑" },
  });
  assert.throws(() => parseAiSuggestions("[]"));
  assert.throws(() => parseAiSuggestions("not json"));
  console.info("ok - fenced and dirty AI reply parsing");
}

async function testHttpIntegration(): Promise<void> {
  const rwToken = "RwToken123456789";
  const roToken = "RoToken123456789";
  const meta: DocMeta = {
    rwHash: sha256Hex(rwToken),
    roHash: sha256Hex(roToken),
  };
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              description: "Used laptop computer",
              category: "Electronics",
              hsCode: "847130",
            }),
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const quietLogger = { info: () => undefined, error: () => undefined };
  const dataDir = await mkdtemp(join(tmpdir(), "inventory-ai-server-"));
  const running = await startInventoryServer({
    ai: {
      fetchImpl: fakeFetch,
      getApiKey: () => "test-api-key",
      logger: quietLogger,
    },
    dataDir,
    port: 0,
    quiet: true,
    logger: quietLogger,
    staticDir: join(dataDir, "missing-static"),
  });

  try {
    assert.equal(
      running.metadata.authenticateAndStore(
        VALID_BODY.docId,
        JSON.stringify({ t: rwToken, create: meta }),
      ),
      "rw",
    );
    const url = `http://127.0.0.1:${running.port}/api/ai/analyze`;
    const request = (token?: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-token": token } : {}),
        },
        body: JSON.stringify(VALID_BODY),
      });

    await expectStatus(request(), 401, "missing-token AI request");
    await expectStatus(request(roToken), 403, "read-only AI request");
    const response = await expectStatus(
      request(rwToken),
      200,
      "authorized AI request",
    );
    assert.deepEqual(await response.json(), {
      suggestions: {
        description: "Used laptop computer",
        category: "Electronics",
        hsCode: "847130",
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(String(calls[0]?.input), "https://api.anthropic.com/v1/messages");
    assert.equal(
      new Headers(calls[0]?.init?.headers).get("x-api-key"),
      "test-api-key",
    );
    assert.equal(
      new Headers(calls[0]?.init?.headers).get("anthropic-version"),
      "2023-06-01",
    );
    const upstreamBody = JSON.parse(String(calls[0]?.init?.body)) as {
      model: string;
      max_tokens: number;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    assert.equal(upstreamBody.model, "claude-sonnet-4-5");
    assert.equal(upstreamBody.max_tokens, 1024);
    assert.equal(upstreamBody.messages[0]?.content[0]?.type, "image");
    assert.match(
      String(upstreamBody.messages[0]?.content.at(-1)?.text),
      /customs manifests/,
    );
    console.info("ok - AI auth and happy path through Express");
  } finally {
    await running.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testValidation();
  testRateLimiter();
  testReplyParsing();
  await testHttpIntegration();
  console.info("AI selftest passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
