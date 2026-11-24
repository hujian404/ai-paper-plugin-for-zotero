const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const core = require("../addon/content/core.js");

const source = readFileSync(join(__dirname, "../addon/content/reader-capture.js"), "utf8");
const ops = Object.fromEntries([
  "save", "paintFormXObjectBegin", "restore", "paintFormXObjectEnd", "transform",
  "paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject",
  "paintInlineImageXObjectGroup", "paintImageXObjectRepeat"
].map((name, index) => [name, index]));

async function viewer({ isMac = false, structure = [], tiles = [] } = {}) {
  const handlers = new Map();
  const captures = [];
  const rect = { width: 600, height: 800 };
  const viewport = {
    ...rect, rotation: 0,
    convertToPdfPoint: (x, y) => [x, rect.height - y],
    convertToViewportPoint: (x, y) => [x, rect.height - y]
  };
  const page = {
    pageNumber: 1, view: [0, 0, rect.width, rect.height],
    getOperatorList() {
      return {
        fnArray: tiles.flatMap(() => [ops.save, ops.transform, ops.paintImageXObject, ops.restore]),
        argsArray: tiles.flatMap(tile => [[], tile, [], []])
      };
    }
  };
  const element = {
    clientWidth: rect.width, clientHeight: rect.height, clientLeft: 0, clientTop: 0,
    dataset: { pageNumber: "1" },
    closest: () => element,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    append(node) { node.parentNode = this; }
  };
  const overlay = {
    parentNode: null, style: {},
    setAttribute() {},
    remove() { this.parentNode = null; }
  };
  const doc = {
    createElement: () => overlay,
    elementFromPoint: (x, y) => x >= 0 && x <= rect.width && y >= 0 && y <= rect.height ? element : null,
    getElementById: () => ({ addEventListener() {} }),
    documentElement: { addEventListener() {} }
  };
  const win = {
    document: doc, pdfjsLib: { OPS: ops },
    addEventListener(type, handler) { handlers.set(type, handler); },
    getSelection: () => null
  };
  const app = {
    pdfDocument: { getPageData: () => null },
    pdfViewer: { getPageView: () => ({ pdfPage: page, viewport }) }
  };
  const Cu = { waiveXrays: value => value, cloneInto: value => value, isDeadWrapper: () => false };
  const Zotero = { isMac, debug() {}, logError(error) { assert.fail(error); } };
  const ReaderCapture = runInNewContext(source + "\nAIPaperReaderCapture", { Cu, Zotero });
  new ReaderCapture({
    core,
    addReaderSnapshot(_reader, index, name) {
      captures.push({ index, name });
      return Promise.resolve();
    }
  }).bindView({ _internalReader: { getSDTReader: () => ({ getPageBlocks: () => structure }) } }, win, app);
  function send(type, x, y, options = {}) {
    const event = {
      type, clientX: x, clientY: y, button: 0, isPrimary: true,
      ctrlKey: !isMac, metaKey: isMac, ...options,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() {}
    };
    handlers.get(type)(event);
    return event.prevented;
  }
  send("pointermove", 100, 100);
  await new Promise(resolve => setImmediate(resolve));
  return { captures, overlay, send };
}

test("figure hover prefers joined raster tiles over a partial block and enclosed labels", async () => {
  const { captures, overlay, send } = await viewer({
    structure: [
      { type: "image", anchor: { pageRects: [[0, 120, 500, 190, 610]] } },
      { type: "paragraph", anchor: { pageRects: [[0, 130, 520, 160, 540]] } }
    ],
    tiles: [[100, 0, 0, 160, 100, 480], [100, 0, 0, 160, 200, 480], [50, 0, 0, 160, 320, 480]]
  });
  send("pointermove", 140, 270);
  assert.ok(Math.abs(parseFloat(overlay.style.width) - 204 / 6) < 0.01);
  send("pointerdown", 140, 270);
  send("pointerup", 140, 270);
  assert.equal(send("click", 140, 270), true);
  assert.deepEqual(captures, [{ index: 0, name: "PDF 第 1 页插图" }]);
});

test("a full-page scan leaves overlapping structured text selectable", async () => {
  const { overlay, send } = await viewer({
    structure: [{ type: "paragraph", anchor: { pageRects: [[0, 100, 500, 190, 610]] } }],
    tiles: [[600, 0, 0, 800, 0, 0]]
  });
  send("pointermove", 140, 270);
  assert.ok(Math.abs(parseFloat(overlay.style.width) - 94 / 6) < 0.01);
});

for (const isMac of [false, true]) {
  test(`${isMac ? "Command" : "Ctrl"} drag captures a blank-start region, clamps to the page, and supports cancellation`, async () => {
    const { captures, overlay, send } = await viewer({ isMac });
    assert.equal(send("pointerdown", 300, 400), true);
    send("pointermove", 630, 200);
    assert.equal(overlay.style.left, "50%");
    assert.equal(overlay.style.width, "50%");
    assert.equal(overlay.style.height, "25%");
    send("pointerup", 630, 200);
    assert.equal(send("click", 630, 200), true);
    assert.deepEqual(captures, [{ index: 0, name: "PDF 第 1 页快照" }]);

    send("pointerdown", 100, 100);
    send("pointermove", 300, 300);
    assert.equal(send("keydown", 300, 300, { key: "Escape" }), true);
    send("pointermove", 310, 310);
    assert.equal(overlay.parentNode, null);
    send("pointerup", 310, 310);

    send("pointerdown", 100, 100);
    send("pointermove", 300, 300);
    send("keyup", 300, 300, { ctrlKey: false, metaKey: false });
    send("pointerup", 300, 300);
    assert.equal(captures.length, 1);
    assert.equal(send("pointerdown", 100, 100, { ctrlKey: isMac, metaKey: !isMac }), undefined);
  });
}
