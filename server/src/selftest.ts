import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyAccessToConnection,
  authenticateDoc,
  sha256Hex,
  type DocMeta,
} from "./auth.js";
import { startInventoryServer } from "./index.js";

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

async function main(): Promise<void> {
  const rwToken = "RwToken123456789";
  const roToken = "RoToken123456789";
  const wrongToken = "WrongToken123456";
  const meta: DocMeta = {
    rwHash: sha256Hex(rwToken),
    roHash: sha256Hex(roToken),
  };
  const createTokenJson = JSON.stringify({ t: rwToken, create: meta });

  assert.deepEqual(authenticateDoc(null, createTokenJson), {
    level: "rw",
    createMeta: meta,
  });
  assert.equal(authenticateDoc(null, JSON.stringify({ t: rwToken })), null);
  assert.equal(
    authenticateDoc(
      null,
      JSON.stringify({
        t: wrongToken,
        create: meta,
      }),
    ),
    null,
  );
  assert.deepEqual(
    authenticateDoc(meta, JSON.stringify({ t: roToken })),
    { level: "ro" },
  );

  const connectionConfig = { readOnly: false };
  applyAccessToConnection("ro", connectionConfig);
  assert.equal(connectionConfig.readOnly, true);
  console.info("ok - create auth accepts/rejects and ro is read-only");

  const dataDir = await mkdtemp(join(tmpdir(), "inventory-server-"));
  const running = await startInventoryServer({
    dataDir,
    port: 0,
    quiet: true,
    staticDir: join(dataDir, "missing-static"),
  });

  try {
    assert.equal(
      running.metadata.authenticateAndStore("testDoc001", createTokenJson),
      "rw",
    );

    const baseUrl = `http://127.0.0.1:${running.port}`;
    const health = await expectStatus(
      fetch(`${baseUrl}/api/health`),
      200,
      "health",
    );
    assert.deepEqual(await health.json(), { ok: true });

    const bytes = Buffer.from("content-addressed inventory photo");
    const hash = sha256Hex(bytes);
    const blobUrl = `${baseUrl}/api/blobs/testDoc001/${hash}`;

    await expectStatus(
      fetch(blobUrl, {
        method: "PUT",
        headers: {
          "content-type": "image/webp",
          "x-token": wrongToken,
        },
        body: bytes,
      }),
      403,
      "wrong-token PUT",
    );
    await expectStatus(
      fetch(`${baseUrl}/api/blobs/testDoc001/${"0".repeat(64)}`, {
        method: "PUT",
        headers: {
          "content-type": "image/webp",
          "x-token": rwToken,
        },
        body: bytes,
      }),
      400,
      "hash-mismatch PUT",
    );
    await expectStatus(
      fetch(blobUrl, {
        method: "PUT",
        headers: {
          "content-type": "image/webp",
          "x-token": rwToken,
        },
        body: bytes,
      }),
      204,
      "valid PUT",
    );

    const getResponse = await expectStatus(
      fetch(blobUrl, { headers: { "x-token": roToken } }),
      200,
      "ro GET",
    );
    assert.equal(getResponse.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await getResponse.arrayBuffer()), bytes);

    const headResponse = await expectStatus(
      fetch(blobUrl, {
        method: "HEAD",
        headers: { "x-token": roToken },
      }),
      200,
      "ro HEAD",
    );
    assert.equal(headResponse.headers.get("content-length"), String(bytes.length));

    await expectStatus(
      fetch(blobUrl, { headers: { "x-token": wrongToken } }),
      403,
      "wrong-token GET",
    );
    console.info("ok - blob PUT/GET/HEAD and rejection paths");
  } finally {
    await running.close();
    await rm(dataDir, { recursive: true, force: true });
  }

  console.info("selftest passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
