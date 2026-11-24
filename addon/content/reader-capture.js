"use strict";

var AIPaperReaderCapture = (() => {
  const identity = [1, 0, 0, 1, 0, 0];
  const union = (a, b) => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
  const normalize = ([x1, y1, x2, y2]) => [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  const area = rect => (rect[2] - rect[0]) * (rect[3] - rect[1]);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1]
    && outer[2] >= inner[2] && outer[3] >= inner[3];
  const dragThreshold = 7;
  const viewportRect = (viewport, [x1, y1, x2, y2]) => normalize([
    ...viewport.convertToViewportPoint(x1, y1), ...viewport.convertToViewportPoint(x2, y2)
  ]);

  function structuredBlocks(nodes, pageIndex) {
    const blocks = [];
    for (const node of nodes || []) {
      const rects = (node.anchor?.pageRects || []).filter(rect => rect.length === 5 && rect[0] === pageIndex && rect.every(Number.isFinite));
      const rect = rects.map(rect => normalize(rect.slice(1))).reduce(union, null);
      if (rect && area(rect) > 0 && node.flowClass !== "excluded") blocks.push({ rect, picture: node.type === "image" });
    }
    return blocks;
  }

  function textBlocks(chars) {
    const blocks = [];
    let line = null;
    let paragraph = null;
    let previous = null;
    let vertical = false;
    const endParagraph = () => {
      if (paragraph) blocks.push({ rect: paragraph, picture: false });
      paragraph = previous = null;
    };
    const endLine = () => {
      if (!line) return;
      if (previous) {
        const axis = vertical ? 0 : 1;
        const inline = 1 - axis;
        const height = Math.max(line[axis + 2] - line[axis], previous[axis + 2] - previous[axis]);
        const gap = Math.max(previous[axis] - line[axis + 2], line[axis] - previous[axis + 2]);
        const indent = Math.max(line[inline] - previous[inline + 2], previous[inline] - line[inline + 2]);
        if (gap > height * 0.8 || indent > height) endParagraph();
      }
      paragraph = union(paragraph, line);
      previous = line;
      line = null;
    };
    for (const char of chars || []) {
      const rotated = char.rotation === 90 || char.rotation === 270;
      if (rotated !== vertical) { endLine(); endParagraph(); vertical = rotated; }
      if (char.rect && char.inlineRect && !char.ignorable) {
        const glyph = normalize(char.rect);
        const row = normalize(char.inlineRect);
        const rect = vertical ? [row[0], glyph[1], row[2], glyph[3]] : [glyph[0], row[1], glyph[2], row[3]];
        if (rect.every(Number.isFinite) && area(rect) > 0) line = union(line, rect);
      }
      if (char.lineBreakAfter || char.paragraphBreakAfter) endLine();
      if (char.paragraphBreakAfter) endParagraph();
    }
    endLine();
    endParagraph();
    return blocks;
  }

  function multiply([a, b, c, d, e, f], [g, h, i, j, k, l]) {
    return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
  }

  function rasterBlocks({ fnArray, argsArray }, ops) {
    const blocks = [];
    const stack = [];
    let matrix = identity;
    // PDF.js draws image XObjects in a unit square under the current transform.
    const addImage = ([a, b, c, d, e, f]) => {
      const x = [e, e + a, e + c, e + a + c];
      const y = [f, f + b, f + d, f + b + d];
      const rect = [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)];
      if (rect[2] - rect[0] >= 10 && rect[3] - rect[1] >= 10) blocks.push({ rect, picture: true });
    };
    for (const [index, op] of fnArray.entries()) {
      const args = argsArray[index];
      switch (op) {
        case ops.save:
          stack.push(matrix);
          break;
        case ops.paintFormXObjectBegin:
          stack.push(matrix);
          if (args[0]) matrix = multiply(matrix, args[0]);
          break;
        case ops.restore:
        case ops.paintFormXObjectEnd:
          matrix = stack.pop() || identity;
          break;
        case ops.transform:
          matrix = multiply(matrix, args);
          break;
        case ops.paintImageXObject:
        case ops.paintInlineImageXObject:
        case ops.paintImageMaskXObject:
          addImage(matrix);
          break;
        case ops.paintInlineImageXObjectGroup:
          for (const image of args[1]) addImage(multiply(matrix, image.transform));
          break;
        case ops.paintImageXObjectRepeat: {
          const [, scaleX, scaleY, positions] = args;
          for (let i = 0; i < positions.length; i += 2) {
            addImage(multiply(matrix, [scaleX, 0, 0, scaleY, positions[i], positions[i + 1]]));
          }
          break;
        }
      }
    }
    // One visible figure may be encoded as edge-to-edge raster tiles. Join only aligned strips.
    let rects = blocks.map(({ rect }) => rect);
    for (const axis of [0, 1]) {
      const cross = 1 - axis;
      rects.sort((a, b) => a[cross] - b[cross] || a[cross + 2] - b[cross + 2] || a[axis] - b[axis]);
      const merged = [];
      for (const rect of rects) {
        const previous = merged.at(-1);
        if (previous && Math.abs(previous[cross] - rect[cross]) <= 0.5
            && Math.abs(previous[cross + 2] - rect[cross + 2]) <= 0.5
            && Math.abs(Math.max(previous[axis], rect[axis]) - Math.min(previous[axis + 2], rect[axis + 2])) <= 0.5) {
          merged[merged.length - 1] = union(previous, rect);
        }
        else merged.push(rect);
      }
      rects = merged;
    }
    return rects.map(rect => ({ rect, picture: true }));
  }

  function hit(blocks, x, y, page) {
    let match;
    for (const block of blocks) {
      const [left, bottom, right, top] = block.rect;
      const rect = [Math.max(page[0], left - 2), Math.max(page[1], bottom - 2),
        Math.min(page[2], right + 2), Math.min(page[3], top + 2)];
      if (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]
          && (!match || area(rect) < area(match.rect))) match = { ...block, rect };
    }
    return match;
  }

  function blockAt(blocks, x, y, page) {
    const text = hit(blocks.structure.filter(block => !block.picture), x, y, page)
      || hit(blocks.text, x, y, page);
    const figure = hit(blocks.structure.filter(block => block.picture), x, y, page);
    // Leave OCR text selectable on pages covered by a single scan or background image.
    const raster = hit(blocks.raster.filter(({ rect }) => area(rect) < 0.9 * area(page)), x, y, page);
    if (figure && raster && contains(raster.rect, figure.rect)) return raster;
    return figure || raster || text || hit(blocks.raster, x, y, page);
  }

  async function snapshot(doc, page, rect, rotation, optionalContentConfigPromise) {
    const win = doc.defaultView;
    const base = page.getViewport(Cu.cloneInto({ scale: 1, rotation }, win));
    const [x1, y1, x2, y2] = viewportRect(base, rect);
    const scale = Math.min(3, (AIPaperCore.maxImageDimension - 2) / Math.max(x2 - x1, y2 - y1));
    const left = Math.floor(x1 * scale);
    const top = Math.floor(y1 * scale);
    const viewport = page.getViewport(Cu.cloneInto({ scale, rotation, offsetX: -left, offsetY: -top }, win));
    const canvas = doc.createElement("canvas");
    canvas.width = Math.ceil(x2 * scale) - left;
    canvas.height = Math.ceil(y2 * scale) - top;
    // PDF.js reads its render options from the viewer iframe's JavaScript realm.
    const options = Cu.waiveXrays(Cu.cloneInto({ background: "#ffffff", annotationMode: 0 }, win));
    options.canvas = canvas;
    options.canvasContext = canvas.getContext("2d", { alpha: false });
    options.viewport = viewport;
    options.optionalContentConfigPromise = optionalContentConfigPromise;
    try {
      await page.render(options).promise;
      return AIPaperCore.encodeImage(canvas);
    }
    finally { canvas.width = canvas.height = 0; }
  }

  return class {
    constructor(runtime) {
      this.runtime = runtime;
      this.readers = new Map();
    }

    watch(reader, doc) {
      if (reader?.type !== "pdf" || !doc || this.readers.has(doc)) return;
      const win = doc.defaultView;
      const owner = reader._window;
      const views = new Map();
      const scan = () => {
        for (const frame of doc.querySelectorAll('iframe[src*="pdf/web/viewer.html"]')) {
          const view = frame.contentWindow;
          const app = (view?.wrappedJSObject || view)?.PDFViewerApplication;
          const viewerDoc = view?.document;
          if (!app || !viewerDoc?.getElementById("viewerContainer") || views.has(viewerDoc)) continue;
          views.set(viewerDoc, this.bindView(reader, view, app, () => views.delete(viewerDoc)));
        }
      };
      const keyup = event => {
        if (event.key === (Zotero.isMac ? "Meta" : "Control")) {
          for (const view of views.values()) view.release();
        }
      };
      const close = () => {
        this.readers.delete(doc);
        if (owner && !Cu.isDeadWrapper(owner)) owner.removeEventListener("keyup", keyup, true);
        if (!Cu.isDeadWrapper(doc) && !Cu.isDeadWrapper(win)) {
          doc.removeEventListener("load", scan, true);
          win.removeEventListener("pagehide", close);
          win.removeEventListener("keyup", keyup, true);
        }
        for (const view of views.values()) view.remove();
      };
      this.readers.set(doc, close);
      doc.addEventListener("load", scan, true);
      win.addEventListener("pagehide", close, { once: true });
      win.addEventListener("keyup", keyup, true);
      owner?.addEventListener("keyup", keyup, true);
      scan();
    }

    bindView(reader, win, app, onRemove) {
      const doc = win.document;
      const container = doc.getElementById("viewerContainer");
      const overlay = doc.createElement("div");
      overlay.id = "aip-pdf-block";
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "absolute", zIndex: "30", pointerEvents: "none", borderRadius: "2px",
        outline: "2px solid var(--color-accent, var(--accent-blue, Highlight))", outlineOffset: "-1px",
        background: "color-mix(in srgb, var(--color-accent, var(--accent-blue, Highlight)) 8%, transparent)"
      });
      const cache = new WeakMap();
      const events = ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "dragstart"];
      let pointer = null;
      let capture = null;
      let suppressClick = false;
      let held = false;
      let removed = false;

      function pageBlocks(page) {
        if (cache.has(page)) return cache.get(page);
        const index = page.pageNumber - 1;
        const pdf = app.pdfDocument;
        const blocks = { structure: [], text: [], raster: [] };
        cache.set(page, blocks);
        const load = (kind, read) => Promise.resolve().then(read).then(result => {
          blocks[kind] = result;
          if (!removed) refresh();
        }).catch(error => {
          if (!removed && !page.destroyed) Zotero.debug(`AiPluginForZotero PDF 块识别 (${kind})：${error}\n${error.stack || ""}`, 4);
        });
        load("structure", async () => {
          const pack = await reader._internalReader?.getSDTReader?.();
          return structuredBlocks(Cu.waiveXrays(await pack?.getPageBlocks?.(index)), index);
        });
        load("text", async () => textBlocks(Cu.waiveXrays(await pdf?.getPageData?.(Cu.cloneInto({ pageIndex: index }, win)))?.chars));
        const ops = (win.wrappedJSObject || win).pdfjsLib?.OPS;
        if (ops) load("raster", async () => rasterBlocks(Cu.waiveXrays(await page.getOperatorList(Cu.cloneInto({ annotationMode: 0 }, win))), ops));
        return blocks;
      }

      function pageAt({ x, y }) {
        const element = doc.elementFromPoint(x, y)?.closest(".page[data-page-number]");
        const view = element && app.pdfViewer?.getPageView(Number(element.dataset.pageNumber) - 1);
        if (!view?.pdfPage || !element.clientWidth || !element.clientHeight) return null;
        return { element, view, page: view.pdfPage };
      }

      function pdfPoint({ element, view }, { x, y }) {
        const { viewport } = view;
        const bounds = element.getBoundingClientRect();
        return viewport.convertToPdfPoint(
          clamp((x - bounds.left - element.clientLeft) / element.clientWidth, 0, 1) * viewport.width,
          clamp((y - bounds.top - element.clientTop) / element.clientHeight, 0, 1) * viewport.height
        );
      }

      function targetAt(point) {
        const target = pageAt(point);
        if (!target) return null;
        const [x, y] = pdfPoint(target, point);
        const block = blockAt(pageBlocks(target.page), x, y, target.page.view);
        return block && { ...target, ...block };
      }

      function dragTarget(capture, point) {
        const target = capture.page;
        const rect = normalize([...capture.start, ...pdfPoint(target, point)]);
        return area(rect) > 0 && { ...target, rect, picture: false };
      }

      function refresh() {
        const target = held && pointer && (capture?.dragged ? dragTarget(capture, pointer) : targetAt(pointer));
        if (!target) { overlay.remove(); return; }
        const { element, view: { viewport }, rect } = target;
        const [left, top, right, bottom] = viewportRect(viewport, rect);
        Object.assign(overlay.style, {
          left: `${100 * left / viewport.width}%`, top: `${100 * top / viewport.height}%`,
          width: `${100 * (right - left) / viewport.width}%`, height: `${100 * (bottom - top) / viewport.height}%`
        });
        if (overlay.parentNode !== element) element.append(overlay);
      }

      const updateModifier = event => {
        held = this.runtime.core.hasPrimaryModifier(event, Zotero.isMac) && !capture?.cancelled;
        if (event.type === "keydown" && event.key === "Escape" && capture) {
          event.preventDefault();
          event.stopImmediatePropagation();
          release();
          return;
        }
        if (!held && capture) capture.cancelled = true;
        refresh();
      };
      const move = event => {
        if (event.isPrimary === false) return;
        pointer = { x: event.clientX, y: event.clientY };
        if (capture && !capture.dragged && !capture.cancelled
            && Math.hypot(pointer.x - capture.point.x, pointer.y - capture.point.y) > dragThreshold) {
          capture.dragged = true;
          if (event.isTrusted && (event.buttons & 1)) {
            try { capture.page.element.setPointerCapture(event.pointerId); }
            catch (error) {
              if (error.name !== "NotFoundError") Zotero.logError(error);
            }
          }
        }
        held = this.runtime.core.hasPrimaryModifier(event, Zotero.isMac) && !capture?.cancelled;
        if (!held && capture) capture.cancelled = true;
        refresh();
      };
      const release = () => {
        held = false;
        if (capture) capture.cancelled = true;
        if (!Cu.isDeadWrapper(overlay)) overlay.remove();
      };
      const leave = () => { pointer = null; release(); };
      const resetNativeSelection = () => {
        const internal = reader._internalReader;
        const view = [internal?._primaryView, internal?._secondaryView].find(entry => entry?._iframeWindow
          && Cu.unwaiveXrays(entry._iframeWindow) === Cu.unwaiveXrays(win));
        // Zotero's window capture listener can run first and leave a selectText action awaiting mouseup.
        if (view?._clearPointerAction) view._clearPointerAction();
        else if (view) {
          view.action = null;
          view.pointerDownPosition = null;
          view._pointerDownTriggered = false;
          view._pointerDownTap = null;
          view._autoScroll?.disable();
        }
        const selection = win.getSelection();
        if (view?._selectionRanges?.length || selection?.isCollapsed === false) {
          view?.clearSelection?.();
          selection?.removeAllRanges();
          view?._render?.();
        }
      };
      const consume = event => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const click = event => {
        if (event.isPrimary === false) return;
        const point = { x: event.clientX, y: event.clientY };
        if (event.type === "pointerdown" || event.type === "mousedown") {
          if (event.button !== 0) return;
          if (event.type === "mousedown" && capture) { consume(event); return; }
          suppressClick = false;
          const page = this.runtime.core.hasPrimaryModifier(event, Zotero.isMac) && pageAt(point);
          if (!page) { capture = null; return; }
          capture = { page, point, start: pdfPoint(page, point), dragged: false, cancelled: false };
          consume(event);
          resetNativeSelection();
          return;
        }
        if (event.type === "click") {
          if (suppressClick && event.button === 0) { suppressClick = false; consume(event); }
          return;
        }
        if (event.type === "mouseup" && !capture && suppressClick && event.button === 0) { consume(event); return; }
        if (!capture || (event.type !== "pointercancel" && event.type !== "dragstart" && event.button !== 0)) return;
        consume(event);
        if (event.type === "dragstart") return;
        resetNativeSelection();
        const gesture = capture;
        capture = null;
        suppressClick = true;
        if (event.type === "pointercancel" || gesture.cancelled
            || !this.runtime.core.hasPrimaryModifier(event, Zotero.isMac)) { release(); return; }
        const dragged = gesture.dragged || Math.hypot(point.x - gesture.point.x, point.y - gesture.point.y) > dragThreshold;
        const target = dragged ? dragTarget(gesture, point) : targetAt(gesture.point);
        if (!target) { refresh(); return; }
        const { page, rect, view: { viewport }, picture } = target;
        const name = `PDF 第 ${page.pageNumber} 页${picture ? "插图" : "快照"}`;
        const layers = app.pdfViewer.optionalContentConfigPromise;
        this.runtime.addReaderSnapshot(reader, page.pageNumber - 1, name, () => snapshot(doc, page, rect, viewport.rotation, layers))
          .catch(error => Zotero.logError(error));
        refresh();
      };
      const pageRendered = () => {
        refresh();
        Promise.resolve().then(() => {
          if (!removed) this.runtime.readerSelection.installOutline(reader);
        }).catch(error => Zotero.logError(error));
      };
      const remove = () => {
        if (removed) return;
        removed = true;
        leave();
        onRemove();
        if (Cu.isDeadWrapper(doc) || Cu.isDeadWrapper(win)) return;
        win.removeEventListener("pointermove", move, true);
        win.removeEventListener("keydown", updateModifier, true);
        win.removeEventListener("keyup", updateModifier, true);
        win.removeEventListener("blur", leave);
        win.removeEventListener("pagehide", remove);
        doc.documentElement.removeEventListener("mouseleave", leave);
        container.removeEventListener("scroll", refresh);
        app.eventBus?.off("pagerendered", pageRendered);
        for (const type of events) win.removeEventListener(type, click, true);
      };
      win.addEventListener("pointermove", move, true);
      win.addEventListener("keydown", updateModifier, true);
      win.addEventListener("keyup", updateModifier, true);
      win.addEventListener("blur", leave);
      win.addEventListener("pagehide", remove, { once: true });
      doc.documentElement.addEventListener("mouseleave", leave);
      container.addEventListener("scroll", refresh, { passive: true });
      app.initializedPromise?.then(() => {
        if (removed) return;
        app.eventBus?.on("pagerendered", pageRendered);
        pageRendered();
      });
      for (const type of events) win.addEventListener(type, click, true);
      return { release, remove };
    }

    destroy() {
      for (const close of this.readers.values()) close();
    }
  };
})();
