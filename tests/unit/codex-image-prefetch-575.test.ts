/**
 * Codex executor: remote image URLs must be fetched and inlined as base64 data
 * URIs BEFORE the request body reaches the upstream Codex backend (closes #575).
 *
 * The Codex backend cannot fetch remote HTTP(S) images, so `CodexExecutor`
 * runs a `prefetchImages()` step ahead of the synchronous transform/execute
 * pipeline:
 *  - remote `image_url` parts are awaited and inlined as `input_image` base64
 *  - existing `data:` URIs pass through without a network fetch
 *  - a failed fetch falls back to the original URL (never throws)
 *  - the original request body is left untouched (combo quality checks rely on it)
 *
 * Run: node --import tsx/esm --test tests/unit/codex-image-prefetch-575.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CodexExecutor } from "../../open-sse/executors/codex.ts";

const IMAGE_BYTES = 64 * 1024;
const REMOTE_URL = "https://example.com/big.jpg";
const DATA_URI = "data:image/png;base64,iVBORw0KGgo=";

function makeImageBuffer(sizeBytes: number): ArrayBuffer {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = i & 0xff;
  return buf.buffer;
}

function mockImageFetch(sizeBytes: number, mimeType = "image/jpeg") {
  return {
    ok: true,
    headers: { get: (k: string) => (k === "Content-Type" ? mimeType : null) },
    arrayBuffer: async () => makeImageBuffer(sizeBytes),
  } as unknown as Response;
}

type ContentPart = Record<string, unknown>;

function userImageBody(imageUrl: unknown): Record<string, unknown> {
  return {
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          { type: "image_url", image_url: imageUrl },
        ],
      },
    ],
  };
}

function findImageBlock(body: unknown): ContentPart | undefined {
  const input = (body as Record<string, unknown>)?.input as Array<Record<string, unknown>>;
  const content = input?.[0]?.content as ContentPart[];
  return content?.find((c) => c.type === "input_image");
}

test("prefetchImages fetches a remote image and inlines it as a base64 data URI", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return mockImageFetch(IMAGE_BYTES);
  }) as typeof global.fetch;

  try {
    const executor = new CodexExecutor();
    const body = userImageBody({ url: REMOTE_URL, detail: "high" });

    const result = await executor.prefetchImages(body);

    const imgBlock = findImageBlock(result);
    assert.ok(imgBlock, "input_image block must be present after prefetch");
    assert.equal(imgBlock.type, "input_image");
    assert.equal(imgBlock.detail, "high");
    const imageUrl = imgBlock.image_url as string;
    assert.ok(
      imageUrl.startsWith("data:image/jpeg;base64,"),
      `expected base64 data URI, got: ${imageUrl.slice(0, 40)}`
    );
    const base64Payload = imageUrl.split(",")[1];
    assert.equal(Buffer.from(base64Payload, "base64").length, IMAGE_BYTES);
    assert.equal(calls, 1);

    // Original body must be untouched (combo quality checks inspect it).
    const original = findImageBlock(body);
    assert.equal(original, undefined, "original body must still carry the raw image_url part");
  } finally {
    global.fetch = originalFetch;
  }
});

test("prefetchImages passes through existing data URIs without a network fetch", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return mockImageFetch(IMAGE_BYTES);
  }) as typeof global.fetch;

  try {
    const executor = new CodexExecutor();
    const result = await executor.prefetchImages(userImageBody({ url: DATA_URI }));

    const imgBlock = findImageBlock(result);
    assert.ok(imgBlock);
    assert.equal(imgBlock.image_url, DATA_URI);
    assert.equal(calls, 0, "data: URIs must not trigger a network fetch");
  } finally {
    global.fetch = originalFetch;
  }
});

test("prefetchImages falls back to the original URL when the remote fetch fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("network down");
  }) as typeof global.fetch;

  try {
    const executor = new CodexExecutor();
    const result = await executor.prefetchImages(userImageBody({ url: REMOTE_URL }));

    const imgBlock = findImageBlock(result);
    assert.ok(imgBlock);
    assert.equal(imgBlock.image_url, REMOTE_URL);
  } finally {
    global.fetch = originalFetch;
  }
});

test("prefetchImages leaves bodies without an input array unchanged", async () => {
  const executor = new CodexExecutor();
  const body = { messages: [{ role: "user", content: "hi" }] };
  const result = await executor.prefetchImages(body);
  assert.equal(result, body, "no input array -> original body reference returned");
});
