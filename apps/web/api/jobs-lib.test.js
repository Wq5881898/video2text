const assert = require("node:assert/strict");
const test = require("node:test");
const {
  pollTranscriptionWindow,
  translateSegments,
  translateWorkBatch,
} = require("./jobs-lib");

const source = [{ start: 0, end: 1, speaker: null, text: "Hello" }];

async function withMiniMaxResponse(choice, run) {
  const previousFetch = global.fetch;
  const previousKey = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, "MiniMax-M3");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    return { ok: true, json: async () => ({ choices: [typeof choice === "function" ? choice(request) : choice] }) };
  };
  try {
    await run();
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previousKey;
  }
}

test("MiniMax returns aligned subtitles", async () => {
  await withMiniMaxResponse({
    finish_reason: "stop",
    message: { content: JSON.stringify({ translations: [{ id: 0, text: "你好" }] }) },
  }, async () => {
    const result = await translateSegments(source);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "你好");
    assert.equal(result[0].start, 0);
  });
});

test("MiniMax accepts the line-based translation protocol", async () => {
  await withMiniMaxResponse({
    finish_reason: "stop",
    message: { content: "0\t你好" },
  }, async () => {
    const result = await translateSegments(source);
    assert.equal(result[0].text, "你好");
  });
});

test("translation work advances one persisted batch at a time", async () => {
  const segments = Array.from({ length: 25 }, (_, index) => ({
    start: index,
    end: index + 1,
    speaker: null,
    text: `Line ${index}`,
  }));
  await withMiniMaxResponse((request) => {
    const items = JSON.parse(request.messages[1].content).segments;
    return {
      finish_reason: "stop",
      message: {
        content: items.map((item) => `${item.id}\tZH ${item.text}`).join("\n"),
      },
    };
  }, async () => {
    const first = await translateWorkBatch({
      job: {},
      segments_en: segments,
      segments_zh: [],
      next_index: 0,
    });
    assert.equal(first.next_index, 20);
    assert.equal(first.segments_zh.length, 20);

    const second = await translateWorkBatch(first);
    assert.equal(second.next_index, 25);
    assert.equal(second.segments_zh.length, 25);
    assert.equal(second.segments_zh[24].text, "ZH Line 24");
  });
});

test("transcription polling checkpoints instead of failing when still pending", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GLADIA_API_KEY;
  process.env.GLADIA_API_KEY = "test-gladia-key";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ status: "processing" }),
  });
  try {
    const result = await pollTranscriptionWindow("gladia-job", {
      maxIterations: 1,
      pollIntervalMs: 0,
    });
    assert.deepEqual(result, {
      done: false,
      result: null,
      status: "processing",
    });
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GLADIA_API_KEY;
    else process.env.GLADIA_API_KEY = previousKey;
  }
});

test("transcription polling returns a later completed result", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GLADIA_API_KEY;
  process.env.GLADIA_API_KEY = "test-gladia-key";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () =>
        calls === 1
          ? { status: "processing" }
          : { status: "done", result: { transcription: { utterances: [] } } },
    };
  };
  try {
    const result = await pollTranscriptionWindow("gladia-job", {
      maxIterations: 2,
      pollIntervalMs: 0,
    });
    assert.equal(result.done, true);
    assert.equal(result.status, "done");
    assert.equal(calls, 2);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GLADIA_API_KEY;
    else process.env.GLADIA_API_KEY = previousKey;
  }
});

test("MiniMax rejects mismatched ids", async () => {
  await withMiniMaxResponse({
    finish_reason: "stop",
    message: { content: JSON.stringify({ translations: [{ id: 1, text: "你好" }] }) },
  }, async () => {
    await assert.rejects(translateSegments(source), /mismatched translations/);
  });
});

test("MiniMax rejects truncated output", async () => {
  await withMiniMaxResponse({ finish_reason: "length", message: { content: "{}" } }, async () => {
    await assert.rejects(translateSegments(source), /incomplete/);
  });
});

test("MiniMax retries a malformed JSON response", async () => {
  let calls = 0;
  await withMiniMaxResponse(() => {
    calls += 1;
    return {
      finish_reason: "stop",
      message: { content: calls === 1 ? '{"translations":[{"id":0,"text":"你好"' : JSON.stringify({ translations: [{ id: 0, text: "你好" }] }) },
    };
  }, async () => {
    const result = await translateSegments(source);
    assert.equal(result[0].text, "你好");
    assert.equal(calls, 2);
  });
});

test("MiniMax splits a repeatedly malformed batch", async () => {
  let calls = 0;
  const twoSegments = [...source, { start: 1, end: 2, speaker: null, text: "Bye" }];
  await withMiniMaxResponse((request) => {
    calls += 1;
    const items = JSON.parse(request.messages[1].content).segments;
    return {
      finish_reason: "stop",
      message: { content: items.length > 1 ? "{broken" : JSON.stringify({ translations: [{ id: 0, text: items[0].text === "Hello" ? "你好" : "再见" }] }) },
    };
  }, async () => {
    const result = await translateSegments(twoSegments);
    assert.deepEqual(result.map((item) => item.text), ["你好", "再见"]);
    assert.equal(calls, 4);
  });
});

test("MiniMax does not split quota errors", async () => {
  let calls = 0;
  const previousFetch = global.fetch;
  const previousKey = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "test-key";
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "Rate limited" };
  };
  try {
    await assert.rejects(translateSegments([source[0], { ...source[0], text: "Bye" }]), /HTTP 429/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previousKey;
  }
});
