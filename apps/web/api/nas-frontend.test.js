const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Execute the real entrypoint and mode detector with a DOM and transport double.
// No uploads, provider calls, or external requests are made by these tests.
async function frontend(surface, address) {
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, {
      value: "", files: [], disabled: false, hidden: false, textContent: "Vercel copy",
      classList: { add() {}, remove() {} }, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
    });
    return elements.get(key);
  };
  element("source-url").value = "https://example.com/stale.wav";
  element("output-format").value = "srt";
  element("translate").checked = true;
  const calls = [], uploads = [], redirects = [];
  const parsedLocation = new URL(address);
  const location = {
    hostname: parsedLocation.hostname, pathname: parsedLocation.pathname,
    search: parsedLocation.search, href: address,
    assign: (url) => redirects.push(url),
  };
  const context = vm.createContext({
    URL, URLSearchParams, Date, Error, AbortController, console,
    document: { getElementById: element, querySelector: element },
    window: { location, setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {} },
    uploadFileToNas: async (file, options) => {
      uploads.push({ kind: "nas", file, options });
      return { job_url: "/nas/jobs/test-job" };
    },
    uploadToBlob: async (name, file) => {
      uploads.push({ kind: "blob", file });
      return { url: "https://blob.example/upload.wav" };
    },
    fetch: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const payload = url.endsWith("jobs-create")
        ? { ok: true, job_url: "/jobs/job_123456789abc" }
        : url.endsWith("transcribe")
          ? { ok: true, result: { output_text: "Test", output_filename: "test.srt" } }
          : { ok: true, splitting_supported: true, split_required: false };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    },
  });
  const nas = await fs.readFile(path.join(__dirname, "../public/nas-upload.js"), "utf8");
  vm.runInContext(nas.match(/export function isNasPreviewMode\(\) \{[\s\S]*?\n\}/)[0].replace("export ", ""), context);
  const source = await fs.readFile(path.join(__dirname, `../public/${surface}.js`), "utf8");
  vm.runInContext(source.replace(/^import[^\n]+\n/gm, ""), context);
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0; // Desktop initialization only probes health/capabilities.
  return { element, calls, uploads, redirects, location,
    submit: () => element(surface === "web" ? "transcribe-form" : "mobile-form").listeners.submit({ preventDefault() {} }),
  };
}

for (const surface of ["web", "mobile"]) {
  for (const address of ["https://example.com/nas", "https://example.com/mobile?storage=nas", "https://stt.151077.xyz/mobile"]) {
    test(`${surface}: ${address} hides URL input and retains local-only state after events`, async () => {
      const page = await frontend(surface, address);
      for (const event of [null, "change", "input"]) {
        if (event) {
          page.element("source-url").value = event === "input" ? "https://example.com/injected.wav" : "";
          page.element(event === "change" ? "source-file" : "source-url").listeners[event]();
        }
        assert.equal(page.element("url-card").hidden, true);
        assert.equal(page.element("source-url").disabled, true);
        assert.equal(page.element("source-url").value, "");
        assert.equal(page.element("source-file").disabled, false);
      }
      assert.match(page.element(".lede").textContent, /local.*Ubuntu\/NAS/);
      assert.match(page.element("#upload-card .entry-head p").textContent, /Ubuntu\/NAS/);
      const link = surface === "web" ? '.alt-mode-link[href="/mobile"]' : '.alt-mode-link[href="/"]';
      assert.equal(page.element(link).href, surface === "web" ? "/mobile?storage=nas" : "/nas");
    });

    for (const injectedUrl of ["", "https://example.com/injected.wav"]) {
      test(`${surface}: ${address} rejects no-file submit (URL=${Boolean(injectedUrl)}) without cloud requests`, async () => {
        const page = await frontend(surface, address);
        page.element("source-url").value = injectedUrl;
        page.element("source-url").disabled = false;
        await page.submit();
        assert.deepEqual(page.calls, []);
        assert.deepEqual(page.uploads, []);
        assert.match(page.element("result-summary").innerHTML, /Choose a local file.*Ubuntu\/NAS/);
        assert.equal(page.element("source-url").value, "");
        assert.equal(page.element("source-url").disabled, true);
      });
    }

    test(`${surface}: ${address} local file uses NAS only even with an injected URL`, async () => {
      const page = await frontend(surface, address);
      const file = { name: "test.wav", size: 1024 };
      page.element("source-file").files = [file];
      page.element("source-url").value = "https://example.com/injected.wav";
      await page.submit();
      assert.deepEqual(page.calls, []);
      assert.equal(page.uploads.length, 1);
      assert.equal(page.uploads[0].kind, "nas");
      assert.equal(page.uploads[0].file, file);
      assert.equal(page.uploads[0].options.outputFormat, "srt");
      assert.equal(page.uploads[0].options.translate, true);
      assert.equal(surface === "web" ? page.redirects[0] : page.location.href, "/nas/jobs/test-job");
    });
  }

  test(`${surface}: Vercel keeps URL card, copy, and mutual exclusion`, async () => {
    const page = await frontend(surface, "https://example.vercel.app/");
    assert.equal(page.element("url-card").hidden, false);
    assert.equal(page.element("source-url").disabled, false);
    assert.equal(page.element(".lede").textContent, "Vercel copy");
    page.element("source-url").listeners.input();
    assert.equal(page.element("source-file").disabled, true);
    page.element("source-url").value = "";
    page.element("source-url").listeners.input();
    assert.equal(page.element("source-file").disabled, false);
    assert.equal(page.element("source-url").disabled, false);
  });

  for (const localFile of [false, true]) {
    test(`${surface}: Vercel ${localFile ? "file" : "URL"} submit retains cloud route`, async () => {
      const page = await frontend(surface, "https://example.vercel.app/");
      if (localFile) page.element("source-file").files = [{ name: "test.wav", size: 1024 }];
      await page.submit();
      assert.deepEqual(page.uploads.map((upload) => upload.kind), localFile ? ["blob"] : []);
      assert.deepEqual(page.calls.map((call) => call.url), surface === "web"
        ? ["./api/media-info", "./api/transcribe"] : ["./api/jobs-create"]);
      assert.equal(page.calls[0].body.source_url, localFile ? "https://blob.example/upload.wav" : "https://example.com/stale.wav");
    });
  }
}
