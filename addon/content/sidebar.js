"use strict";

const WORKTREE_LABEL_LENGTH = 28;
const NATIVE_CLIPBOARD_IMAGE = "application/x-moz-nativeimage";
const CLIPBOARD_IMAGE_FORMATS = ["image/png", "image/jpeg", "image/webp", "image/gif", NATIVE_CLIPBOARD_IMAGE];
const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MESSAGE_ICON_PATHS = {
  copy: "M5.75 5.5h6.5a1.75 1.75 0 0 1 1.75 1.75v5a1.75 1.75 0 0 1-1.75 1.75h-6.5A1.75 1.75 0 0 1 4 12.25v-5A1.75 1.75 0 0 1 5.75 5.5ZM2 10V3.75C2 2.78 2.78 2 3.75 2H10",
  branch: "M4 13V4.7M4 10c0-2.8 2.1-4.5 5-4.5h2.9M9.6 3l2.5 2.5L9.6 8M2 5l2-2 2 2",
  edit: "M10.5 3.5l2 2m-8.9 4.9-.6 2.8 2.8-.6 7.3-7.3a1.4 1.4 0 0 0-2-2l-7.5 7.1Z"
};

var AIPaperSidebar = class {
  constructor(runtime, { body, doc, tabType, layout }) {
    this.runtime = runtime;
    this.body = body;
    this.doc = doc;
    this.win = doc.defaultView;
    this.tabType = tabType;
    this.layout = layout;
    this.context = { key: "initial", supported: false };
    this.revision = 0;
    this.session = null;
    this.selectedTurnID = null;
    this.task = null;
    this.view = "chat";
    this.files = [];
    this.pendingViews = new Map();
    this.editingQuestion = null;
    const template = new DOMParser().parseFromString(`
      <div xmlns="http://www.w3.org/1999/xhtml" class="aip-chat">
        <section class="aip-upper" aria-label="论文问答与会话导航">
          <header class="aip-toolbar">
            <div class="aip-paper-heading"><span data-ui="running" class="aip-running-dot" role="img" aria-label="正在生成回答" hidden="hidden"></span><div class="aip-paper-title" data-ui="title">论文问答</div></div>
            <div class="aip-toolbar-actions" role="group" aria-label="会话与侧栏操作">
              <button type="button" data-ui="worktree" class="aip-icon-button" aria-label="工作树" aria-pressed="false"><img class="aip-toolbar-icon" src="chrome://zotero/skin/16/universal/merge.svg" alt="" aria-hidden="true"/></button>
              <button type="button" data-ui="history" class="aip-icon-button" aria-label="历史会话" aria-pressed="false"><img class="aip-toolbar-icon" src="chrome://zotero/skin/16/universal/note.svg" alt="" aria-hidden="true"/></button>
              <button type="button" data-ui="newSession" class="aip-icon-button" aria-label="新会话"><img class="aip-toolbar-icon" src="chrome://zotero/skin/16/universal/plus.svg" alt="" aria-hidden="true"/></button>
              <button type="button" data-ui="collapse" class="aip-icon-button aip-collapse" aria-label="收起侧栏"><img class="aip-toolbar-icon aip-collapse-icon" src="chrome://zotero/skin/16/universal/chevron-12.svg" alt="" aria-hidden="true"/></button>
            </div>
          </header>
          <div class="aip-messages" data-ui="messages" role="log" aria-label="论文问答内容"></div>
          <div class="aip-history" data-ui="historyView" hidden="hidden" aria-label="历史会话记录"></div>
          <div class="aip-worktree" data-ui="worktreeView" hidden="hidden" aria-label="当前论文的工作树"></div>
        </section>
        <section class="aip-composer" aria-label="问题输入">
          <div class="aip-input-surface">
            <div data-ui="files" class="aip-files" hidden="hidden" aria-label="待发送附件"></div>
            <textarea data-ui="question" rows="2" maxlength="5000" aria-label="输入论文问题" placeholder="输入关于这篇论文的问题…"></textarea>
            <div class="aip-compose-actions">
              <button type="button" data-ui="addFiles" class="aip-icon-button" aria-label="添加文件"><img class="aip-toolbar-icon" src="chrome://zotero/skin/16/universal/plus.svg" alt="" aria-hidden="true"/></button>
              <select data-ui="model" class="aip-model-picker" aria-label="选择模型"></select>
              <button type="button" data-ui="stop" class="aip-primary aip-send-control" aria-label="停止生成" hidden="hidden"><span class="aip-stop-icon" aria-hidden="true"></span></button>
              <button type="button" data-ui="send" class="aip-primary aip-send-control" aria-label="发送问题"><img class="aip-toolbar-icon" src="chrome://zotero/skin/16/universal/up.svg" alt="" aria-hidden="true"/></button>
            </div>
          </div>
          <p data-ui="status" class="aip-status" role="status" aria-live="polite" hidden="hidden"></p>
        </section>
      </div>`, "application/xhtml+xml");
    if (template.querySelector("parsererror")) throw new Error("论文对话框无法加载。 ");
    this.root = this.doc.importNode(template.documentElement, true);
    body.append(this.root);
    this.ui = Object.fromEntries(Array.from(this.root.querySelectorAll("[data-ui]"), node => [node.getAttribute("data-ui"), node]));
    this.tooltip = this.doc.createXULElement("tooltip");
    this.tooltip.id = "aip-tooltip-" + this.runtime.core.uniqueID();
    this.tooltip.setAttribute("noautohide", "true");
    this.tooltipLabel = this.doc.createXULElement("label");
    this.tooltip.append(this.tooltipLabel);
    this.doc.documentElement.append(this.tooltip);
    for (const name of ["worktree", "history", "newSession", "collapse", "addFiles", "send", "stop"]) {
      this.bindTooltip(this.ui[name]);
    }
    this.createMenus();
    this.ui.addFiles.addEventListener("click", () => this.addFiles());
    this.ui.send.addEventListener("click", () => this.send());
    this.ui.model.addEventListener("change", () => this.changeModel());
    this.ui.stop.addEventListener("click", () => this.stop());
    this.ui.newSession.addEventListener("click", () => this.newSession());
    this.ui.collapse.addEventListener("click", () => layout.collapse(tabType));
    for (const view of ["worktree", "history"]) {
      this.ui[view].addEventListener("click", () => {
        this.view = this.view === view ? "chat" : view;
        this.render();
      });
    }
    this.ui.messages.addEventListener("click", event => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      event.preventDefault();
      Zotero.launchURL(link.getAttribute("href"));
    });
    this.ui.question.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.isTrusted && event.key.toLowerCase() === "v"
          && this.runtime.core.hasPrimaryModifier(event, Zotero.isMac)) this.pasteImageShortcut(event);
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.ui.question.addEventListener("input", () => { this.resizeQuestion(); this.updateControls(); });
    this.ui.question.addEventListener("paste", event => this.paste(event));
    this.onHistory = record => {
      if (this.destroyed) return;
      const selected = this.session?.id === record.id;
      if (selected) {
        if (record.deleted) {
          this.task = null;
          this.revision++;
          this.session = null;
          this.selectedTurnID = null;
          this.editingQuestion = null;
          this.status("");
        }
        else this.session = record;
      }
      if (this.view !== "chat" || selected) this.render();
    };
    this.onSettings = () => {
      this.refreshModels();
      if (!this.task && !this.session?.turns.length) this.showReadyStatus();
    };
    this.onProgress = task => {
      if (!this.destroyed && this.view === "chat" && task.conversationID === this.session?.id) {
        const view = this.pendingViews.get(task.turnID);
        if (view) this.updatePendingAnswer(view, task);
      }
    };
    runtime.history.listeners.add(this.onHistory);
    runtime.listeners.add(this.onSettings);
    runtime.progressListeners.add(this.onProgress);
    this.refreshModels();
  }

  element(tag, className, text) {
    const node = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  iconButton(label, iconName) {
    const button = this.element("button", "aip-icon-button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    let icon = iconName;
    if (typeof iconName === "string") {
      icon = this.element("img", "aip-toolbar-icon");
      icon.src = `chrome://zotero/skin/16/universal/${iconName}.svg`;
      icon.alt = "";
    }
    button.append(icon);
    this.bindTooltip(button);
    return button;
  }

  messageButton(label, name, action) {
    const ns = "http://www.w3.org/2000/svg";
    const icon = this.doc.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    const path = this.doc.createElementNS(ns, "path");
    path.setAttribute("d", MESSAGE_ICON_PATHS[name]);
    icon.append(path);
    const button = this.iconButton(label, icon);
    button.classList.add("aip-message-button");
    button.addEventListener("click", action);
    return button;
  }

  copyMessage(text, feedback) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    this.status(feedback);
  }

  createMenus() {
    this.historyMenu = this.doc.createXULElement("menupopup");
    this.historyMenu.classList.add("aip-context-menu");
    this.pinItem = this.doc.createXULElement("menuitem");
    this.deleteItem = this.doc.createXULElement("menuitem");
    this.deleteItem.setAttribute("label", "删除会话");
    this.deleteItem.classList.add("aip-delete-menuitem");
    this.pinItem.addEventListener("command", async () => {
      try {
        const record = this.runtime.history.get(this.menuConversationID);
        await this.runtime.history.setPinned(record.id, !record.pinned);
      }
      catch (error) { this.status(error.message, true); }
    });
    this.deleteItem.addEventListener("command", async () => {
      try { await this.runtime.deleteConversation(this.menuConversationID); }
      catch (error) { this.status(error.message, true); }
    });
    this.historyMenu.append(this.pinItem, this.deleteItem);
    this.noteMenu = this.doc.createXULElement("menupopup");
    this.noteMenu.classList.add("aip-context-menu");
    this.noteItem = this.doc.createXULElement("menuitem");
    this.noteItem.setAttribute("label", "存为笔记");
    this.noteItem.addEventListener("command", () => {
      if (this.noteTarget?.revision === this.revision) this.saveNote(this.noteTarget.turn, this.noteItem);
    });
    this.noteMenu.append(this.noteItem);
    this.doc.documentElement.append(this.historyMenu, this.noteMenu);
  }

  openHistoryMenu(record, button, event) {
    this.menuConversationID = record.id;
    this.pinItem.setAttribute("label", record.pinned ? "取消置顶" : "置顶会话");
    this.openMenu(this.historyMenu, button, event);
  }

  openMenu(menu, anchor, event) {
    event.preventDefault();
    event.stopPropagation();
    this.hideTooltip();
    const bounds = anchor.getBoundingClientRect();
    const pointer = !!(event.clientX || event.clientY);
    menu.openPopup(anchor, "after_start", pointer ? event.clientX - bounds.left : 0,
      pointer ? event.clientY - bounds.bottom : 0, true, false);
  }

  async addFiles() {
    if (this.addingFiles || !this.context.supported) return;
    const revision = this.revision;
    this.addingFiles = true;
    this.updateControls();
    this.status("");
    try {
      const paths = await this.runtime.pickChatFiles(this.win);
      if (this.destroyed || revision !== this.revision) return;
      const documents = [];
      const images = [];
      for (const path of new Set(paths)) {
        if (this.files.some(file => file.path === path)) continue;
        const type = this.runtime.chatImageType(path);
        if (type) images.push({ name: PathUtils.filename(path), path, load: async () => {
          const bytes = await IOUtils.read(path, { maxBytes: CHAT_IMAGE_MAX_BYTES + 1 });
          return this.readImage(new this.win.Blob([bytes], { type }));
        } });
        else documents.push(path);
      }
      const [results, imageErrors] = await Promise.all([
        Promise.allSettled(documents.map(path => this.runtime.readChatFile(path))),
        this.addImages(images)
      ]);
      if (this.destroyed || revision !== this.revision) return;
      for (const result of results) {
        if (result.status === "fulfilled" && !this.files.some(file => file.path === result.value.path)) this.files.push(result.value);
      }
      this.renderFiles();
      const errors = [...imageErrors, ...results.filter(result => result.status === "rejected").map(result => result.reason.message)];
      this.status(errors.join("\n"), !!errors.length);
    }
    catch (error) { if (!this.destroyed && revision === this.revision) this.status(error.message, true); }
    finally { this.addingFiles = false; if (!this.destroyed) this.updateControls(); }
  }

  addTextAttachment(file) {
    if (this.destroyed || !this.context.supported) return;
    this.files.push(file);
    this.renderFiles();
    this.updateControls();
  }

  paste(event) {
    const clipboard = event.clipboardData;
    const images = Array.from(clipboard?.files || []).filter(file => file.type.startsWith("image/"));
    if (!images.length) return; // Keep the textarea's standard text paste and undo behavior.
    event.preventDefault();
    this.insertPastedText(clipboard.getData("text/plain"));
    this.addImages(images.map((file, index) => ({
      name: images.length === 1 ? "粘贴的图片" : `粘贴的图片 ${index + 1}`,
      load: () => this.readImage(file)
    })));
  }

  insertPastedText(value) {
    if (!value) return;
    const text = value.replace(/\r\n?/g, "\n");
    const input = this.ui.question;
    const capacity = input.maxLength - input.value.length + input.selectionEnd - input.selectionStart;
    input.setRangeText(text.slice(0, Math.max(0, capacity)), input.selectionStart, input.selectionEnd, "end");
    this.resizeQuestion();
  }

  readClipboardTransfer(flavors) {
    const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(null);
    for (const flavor of flavors) transferable.addDataFlavor(flavor);
    Services.clipboard.getData(transferable, Services.clipboard.kGlobalClipboard);
    const type = {}, data = {};
    transferable.getAnyTransferData(type, data);
    return { type: type.value, data: data.value };
  }

  pasteImageShortcut(event) {
    const clipboard = Services.clipboard;
    if (!clipboard.hasDataMatchingFlavors(CLIPBOARD_IMAGE_FORMATS, clipboard.kGlobalClipboard)) return;
    // A native image can live on the clipboard without enabling textarea paste in Gecko.
    event.preventDefault();
    if (clipboard.hasDataMatchingFlavors(["text/plain"], clipboard.kGlobalClipboard)) {
      try {
        const { data } = this.readClipboardTransfer(["text/plain"]);
        this.insertPastedText(data.QueryInterface(Ci.nsISupportsString).data);
      }
      catch (error) { Zotero.logError(error); }
    }
    this.addImages([{ name: "粘贴的图片", load: () => this.readNativeClipboardImage() }]);
  }

  readNativeClipboardImage() {
    let { type, data } = this.readClipboardTransfer(CLIPBOARD_IMAGE_FORMATS);
    let stream;
    if (type === NATIVE_CLIPBOARD_IMAGE) {
      const tools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
      type = "image/png";
      stream = tools.encodeImage(data.QueryInterface(Ci.imgIContainer), type, "");
    }
    else stream = data.QueryInterface(Ci.nsIInputStream);
    const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    binary.setInputStream(stream);
    try {
      const length = binary.available();
      if (length > CHAT_IMAGE_MAX_BYTES) throw new Error("剪贴板图片超过 20 MB。");
      const bytes = new this.win.ArrayBuffer(length);
      binary.readArrayBuffer(length, bytes);
      return this.readImage(new this.win.Blob([bytes], { type }));
    }
    finally { binary.close(); }
  }

  async readImage(file) {
    if (file.size > CHAT_IMAGE_MAX_BYTES) throw new Error("图片超过 20 MB。");
    const bitmap = await this.win.createImageBitmap(file);
    try {
      const scale = Math.min(1, this.runtime.core.maxImageDimension / Math.max(bitmap.width, bitmap.height));
      const canvas = this.element("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return this.runtime.core.encodeImage(canvas);
    }
    finally { bitmap.close(); }
  }

  async addImages(sources) {
    if (this.destroyed || !this.context.supported) return [];
    const { maxImages } = this.runtime.core;
    const slots = maxImages - this.files.filter(file => file.kind === "image").length;
    const accepted = sources.slice(0, Math.max(0, slots));
    const errors = [];
    if (accepted.length < sources.length) {
      errors.push(`每条问题最多可添加 ${maxImages} 张图片。`);
      this.status(errors[0], true);
    }
    if (!accepted.length) return errors;
    const entries = accepted.map(({ name, path }) => ({ name, path, id: this.runtime.core.uniqueID(), kind: "image", pending: true }));
    this.files.push(...entries);
    this.renderFiles();
    this.updateControls();
    const results = await Promise.allSettled(accepted.map(async source => source.load()));
    if (this.destroyed) return [];
    for (const [index, entry] of entries.entries()) {
      const current = this.files.indexOf(entry);
      if (current === -1) continue;
      const result = results[index];
      if (result.status === "fulfilled") {
        entry.dataURL = result.value;
        entry.pending = false;
      }
      else {
        this.files.splice(current, 1);
        errors.push(`无法添加${entry.name}。${result.reason?.message || ""}`);
      }
    }
    this.renderFiles();
    this.updateControls();
    if (errors.length) this.status(errors.join("\n"), true);
    return errors;
  }

  imagePreview(image, className) {
    const preview = this.element("img", className);
    preview.alt = image.name;
    preview.title = image.name;
    preview.src = image.dataURL;
    return preview;
  }

  imageButton(image, className, caption) {
    const button = this.element("button", "aip-image-open");
    button.type = "button";
    button.setAttribute("aria-label", "查看 " + image.name);
    button.append(this.imagePreview(image, className));
    if (caption) button.append(caption);
    button.addEventListener("click", () => this.openImage(image));
    return button;
  }

  openImage(image) {
    if (!this.imageDialog) {
      const dialog = this.element("dialog", "aip-image-dialog");
      const header = this.element("header", "aip-image-dialog-header");
      const title = this.element("span");
      title.id = `aip-image-title-${this.runtime.core.uniqueID()}`;
      dialog.setAttribute("aria-labelledby", title.id);
      const close = this.iconButton("关闭图片预览", "cross");
      close.autofocus = true;
      close.addEventListener("click", () => dialog.close());
      header.append(title, close);
      const preview = this.element("img", "aip-image-dialog-image");
      dialog.append(header, preview);
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      dialog.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
      });
      dialog.addEventListener("close", () => { if (!dialog.open) preview.removeAttribute("src"); });
      this.root.append(dialog);
      this.imageDialog = { dialog, preview, title };
    }
    const { dialog, preview, title } = this.imageDialog;
    title.textContent = image.name;
    preview.alt = image.name;
    preview.src = image.dataURL;
    if (!dialog.open) dialog.showModal();
  }

  renderFiles() {
    this.ui.files.replaceChildren(...this.files.map(file => {
      const chip = this.element("div", "aip-file-chip");
      if (file.kind === "image") chip.classList.add("aip-image-chip");
      const name = this.element("span", "aip-file-name", file.pending ? "正在读取…" : file.name);
      name.title = file.name;
      const remove = this.element("button", "aip-file-remove");
      remove.type = "button";
      remove.setAttribute("aria-label", "移除 " + file.name);
      const icon = this.element("img", "aip-toolbar-icon");
      icon.src = "chrome://zotero/skin/16/universal/cross.svg";
      icon.alt = "";
      remove.append(icon);
      remove.addEventListener("click", () => { this.files = this.files.filter(entry => entry.id !== file.id); this.renderFiles(); this.updateControls(); });
      if (file.dataURL) chip.append(this.imageButton(file, "aip-draft-image", name));
      else if (file.pending) chip.append(this.element("div", "aip-draft-image"), name);
      else chip.append(name);
      chip.append(remove);
      return chip;
    }));
    this.ui.files.hidden = !this.files.length;
  }

  resizeQuestion() {
    this.ui.question.style.height = "auto";
    this.ui.question.style.height = Math.min(180, this.ui.question.scrollHeight) + "px";
  }

  clearComposer() {
    this.editingQuestion = null;
    if (this.imageDialog?.dialog.open) this.imageDialog.dialog.close();
    this.ui.question.value = "";
    this.ui.question.style.height = "";
    this.files = [];
    this.renderFiles();
  }

  isRunning(record = this.session) {
    return record ? record.turns.some(turn => turn.state === "pending") : !!this.task && !this.task.cancelled;
  }

  bindTooltip(button) {
    button.addEventListener("mouseenter", () => this.queueTooltip(button));
    button.addEventListener("focus", () => this.queueTooltip(button));
    for (const event of ["mouseleave", "blur", "mousedown", "click", "keydown"]) {
      button.addEventListener(event, () => this.hideTooltip());
    }
  }

  queueTooltip(button) {
    this.hideTooltip();
    this.tooltipButton = button;
    this.tooltipTimer = this.win.setTimeout(() => {
      if (this.destroyed || !button.isConnected) return;
      this.tooltipLabel.value = button.getAttribute("aria-label");
      button.setAttribute("aria-describedby", this.tooltip.id);
      this.tooltip.openPopup(button, "after_end", 0, 2, false, false);
    }, 500);
  }

  hideTooltip() {
    this.win.clearTimeout(this.tooltipTimer);
    this.tooltipButton?.removeAttribute("aria-describedby");
    this.tooltipButton = null;
    this.tooltip.hidePopup();
  }

  update(context) {
    if (this.destroyed) return;
    if (this.context.key === context.key) { this.context = context; this.updateControls(); return; }
    this.task = null;
    this.revision++;
    this.context = context;
    this.session = context.supported ? this.runtime.history.list(context)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null : null;
    this.selectedTurnID = this.session?.turns.at(-1)?.id ?? null;
    this.view = "chat";
    this.clearComposer();
    this.render();
    this.showReadyStatus();
  }

  openRecord(record, context, turnID = record.turns.at(-1)?.id ?? null) {
    this.task = null;
    this.revision++;
    this.context = context;
    this.session = record;
    this.selectedTurnID = turnID;
    this.view = "chat";
    this.clearComposer();
    this.render();
    this.ui.messages.scrollTop = this.ui.messages.scrollHeight;
    this.status("");
  }

  newSession() {
    this.task = null;
    this.revision++;
    this.session = null;
    this.selectedTurnID = null;
    this.view = "chat";
    this.clearComposer();
    this.render();
    this.showReadyStatus();
    this.ui.question.focus();
  }

  showReadyStatus() {
    try {
      if (!this.context.supported) this.status("请先选择一篇论文，或从历史会话中打开论文。 ");
      else this.status("");
    }
    catch (error) { this.status(error.message, true); }
  }

  status(message, error = false) {
    if (this.destroyed) return;
    this.ui.status.textContent = message;
    this.ui.status.hidden = !message;
    this.ui.status.classList.toggle("aip-error", error);
  }

  updateControls() {
    const selected = this.session?.turns.find(turn => turn.id === this.selectedTurnID);
    const pending = !!this.task || selected?.state === "pending";
    const browsing = this.view !== "chat";
    this.ui.running.hidden = !(pending || this.isRunning());
    this.ui.send.disabled = pending || !!this.addingFiles || this.files.some(file => file.pending)
      || !!this.modelChange || !this.context.supported || browsing || !this.ui.model.value;
    this.ui.send.hidden = pending;
    this.ui.stop.hidden = !pending;
    this.ui.question.disabled = !this.context.supported || browsing;
    this.ui.model.disabled = pending || !!this.modelChange || browsing || this.ui.model.options.length <= 1;
    this.ui.addFiles.disabled = !!this.addingFiles || !this.context.supported || browsing;
    this.ui.worktree.disabled = !this.context.supported && !this.session;
  }

  refreshModels() {
    if (this.destroyed) return;
    try {
      const { mode, model, options } = this.runtime.modelPicker();
      const placeholder = this.element("option", "", options.length ? "选择模型" : "暂无模型");
      placeholder.value = "";
      placeholder.disabled = true;
      this.ui.model.replaceChildren(placeholder, ...options.map(({ id, label }) => {
        const option = this.element("option", "", label);
        option.value = id;
        return option;
      }));
      this.modelMode = mode;
      this.ui.model.value = model;
      this.ui.model.title = this.ui.model.selectedOptions[0]?.textContent || "";
      this.sizeModelPicker();
      this.updateControls();
    }
    catch (error) { this.status(error.message, true); }
  }

  sizeModelPicker() {
    const style = this.win.getComputedStyle(this.ui.model);
    const canvas = this.element("canvas");
    const context = canvas.getContext("2d");
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const label = this.ui.model.selectedOptions[0]?.textContent || "";
    this.ui.model.style.width = Math.ceil(context.measureText(label).width + 28) + "px";
  }

  async changeModel() {
    const selected = this.ui.model.value;
    if (!selected) return;
    const operation = this.runtime.selectModel(selected, this.modelMode);
    this.modelChange = operation;
    this.updateControls();
    try {
      await operation;
      if (!this.destroyed) this.status("");
    }
    catch (error) {
      if (!this.destroyed) { this.refreshModels(); this.status(error.message, true); }
    }
    finally {
      if (this.modelChange === operation) this.modelChange = null;
      if (!this.destroyed) this.updateControls();
    }
  }

  render() {
    if (this.destroyed) return;
    this.hideTooltip();
    this.ui.title.textContent = this.session?.paper.title || this.context.item?.getField("title") || "论文问答";
    this.ui.title.title = this.ui.title.textContent;
    for (const [view, label] of [["worktree", "工作树"], ["history", "历史会话"]]) {
      const showing = this.view === view;
      this.ui[view].setAttribute("aria-pressed", String(showing));
      this.ui[view].setAttribute("aria-label", showing ? "返回问答" : label);
      this.ui[view + "View"].hidden = !showing;
    }
    this.ui.messages.hidden = this.view !== "chat";
    if (this.view === "worktree") this.renderWorktree();
    else if (this.view === "history") this.renderHistory();
    else this.renderMessages();
    this.updateControls();
  }

  renderMessages() {
    const container = this.ui.messages;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    const activeEditor = this.doc.activeElement?.matches(".aip-edit-question") && container.contains(this.doc.activeElement)
      ? this.doc.activeElement : null;
    const selection = activeEditor && [activeEditor.selectionStart, activeEditor.selectionEnd, activeEditor.selectionDirection];
    const expanded = new Set([...container.querySelectorAll('.aip-answer-process[open][data-state="complete"]')]
      .map(details => details.dataset.turnId));
    this.pendingViews.clear();
    container.replaceChildren();
    const path = this.runtime.core.turnPath(this.session?.turns || [], this.selectedTurnID);
    for (const turn of path) {
      container.append(this.renderQuestion(turn));
      const response = this.element("article", "aip-answer");
      if (turn.state === "pending") {
        const view = this.createProcessView(turn);
        view.answer = this.element("div", "aip-streaming-answer");
        view.answer.setAttribute("aria-live", "off");
        this.pendingViews.set(turn.id, view);
        const task = [...this.runtime.chatTasks].find(entry => entry.conversationID === this.session.id && entry.turnID === turn.id);
        this.updatePendingAnswer(view, task, turn);
        response.append(view.details, view.answer);
      }
      else if (turn.state === "complete") {
        const view = this.createProcessView(turn);
        this.updateProcessView(view, this.elapsed(turn), turn.usage, turn.process?.steps, turn.process?.reasoning);
        view.details.open = expanded.has(turn.id);
        response.append(view.details);
        const content = this.element("div", "aip-answer-content");
        content.innerHTML = this.runtime.core.markdownHTML(turn.answer);
        response.addEventListener("contextmenu", event => {
          if (!this.context.item || !Zotero.Libraries.get(this.context.item.libraryID)?.editable
              || this.win.getSelection()?.isCollapsed === false || event.target.closest("a")) return;
          this.noteTarget = { turn, revision: this.revision };
          this.openMenu(this.noteMenu, response, event);
        });
        response.append(content);
        if (turn.outputTruncated) response.append(this.element("p", "aip-meta", "回答达到输出 token 上限，可在设置中调整。"));
        const actions = this.element("div", "aip-answer-actions");
        const copy = this.messageButton("复制为 Markdown", "copy", () => this.copyMessage(turn.answer, "已复制 Markdown。 "));
        const branch = this.messageButton("从此处创建分支", "branch", () => this.startBranch(turn.id));
        branch.classList.add("aip-branch-action");
        branch.disabled = !this.context.supported;
        actions.append(copy, branch);
        response.append(actions);
      }
      else {
        response.append(this.element("p", turn.state === "error" ? "aip-error" : "aip-meta", turn.errorMessage || "已停止生成。"));
      }
      container.append(response);
    }
    if (selection) {
      const editor = container.querySelector(".aip-edit-question:enabled");
      editor?.focus({ preventScroll: true });
      editor?.setSelectionRange(...selection);
    }
    if (nearBottom || this.task) container.scrollTop = container.scrollHeight;
  }

  renderQuestion(turn) {
    const question = this.element("article", "aip-question");
    const group = this.element("div", "aip-question-group");
    const row = this.element("div", "aip-question-row");
    row.dataset.turnId = turn.id;
    const editing = this.editingQuestion?.turnID === turn.id;
    group.classList.toggle("aip-question-editing", editing);
    question.append(editing ? this.questionEditor(turn) : this.element("div", "aip-question-text", turn.question));
    if (turn.files?.length) question.append(this.element("div", "aip-question-files", turn.files.map(file => file.name).join(" · ")));
    if (turn.images?.length) {
      const images = this.element("div", "aip-question-images");
      images.append(...turn.images.map(image => this.imageButton(image, "aip-sent-image")));
      question.append(images);
    }
    group.append(question);
    if (!editing) {
      const actions = this.element("div", "aip-question-actions");
      actions.setAttribute("role", "group");
      actions.setAttribute("aria-label", "提问操作");
      const sentAt = new Date(turn.createdAt);
      const time = this.element("time", "", sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
      time.dateTime = turn.createdAt;
      time.title = sentAt.toLocaleString();
      const copy = this.messageButton("复制提问", "copy", () => this.copyMessage(turn.question, "已复制提问。 "));
      const edit = this.messageButton("修改提问", "edit", () => {
        this.editingQuestion = { turnID: turn.id, text: turn.question, sending: false };
        this.renderMessages();
        this.ui.messages.querySelector(".aip-edit-question").focus();
      });
      edit.disabled = !this.context.supported || turn.state === "pending";
      actions.append(time, copy, edit);
      group.append(actions);
    }
    row.append(group);
    return row;
  }

  questionEditor(turn) {
    const editing = this.editingQuestion;
    const editor = this.element("div", "aip-question-editor");
    const input = this.element("textarea", "aip-edit-question");
    input.rows = 3;
    input.maxLength = 5000;
    input.value = editing.text;
    input.setAttribute("aria-label", "修改提问");
    const actions = this.element("div", "aip-edit-actions");
    const cancel = this.element("button", "", "取消");
    const send = this.element("button", "aip-primary", "重新发送");
    cancel.type = send.type = "button";
    input.disabled = cancel.disabled = editing.sending;
    send.disabled = editing.sending || !editing.text.trim();
    input.addEventListener("input", () => { editing.text = input.value; send.disabled = !editing.text.trim(); });
    cancel.addEventListener("click", () => { this.editingQuestion = null; this.renderMessages(); });
    const submit = () => {
      if (send.disabled) return;
      editing.text = input.value;
      editing.sending = true;
      input.disabled = cancel.disabled = send.disabled = true;
      this.resendQuestion(turn, editing);
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229
          && this.runtime.core.hasPrimaryModifier(event, Zotero.isMac)) {
        event.preventDefault();
        submit();
      }
    });
    actions.append(cancel, send);
    editor.append(input, actions);
    return editor;
  }

  createProcessView(turn) {
    const details = this.element("details", "aip-answer-process");
    details.dataset.turnId = turn.id;
    details.dataset.state = turn.state;
    const pending = turn.state === "pending";
    details.open = pending;
    const summary = this.element("summary", "aip-process-summary");
    const metrics = this.element("span", "aip-process-metrics");
    const chevron = this.element("img", "aip-process-chevron");
    chevron.src = "chrome://zotero/skin/16/universal/chevron-12.svg";
    chevron.alt = "";
    summary.append(metrics, chevron);
    const body = this.element("div", "aip-process-body");
    const steps = this.element("ol", "aip-process-steps");
    const reasoning = this.element("div", "aip-process-reasoning");
    const empty = this.element("p", "aip-process-empty");
    if (pending) body.setAttribute("aria-live", "off");
    body.append(steps, reasoning, empty);
    details.append(summary, body);
    return { details, metrics, steps, reasoning, empty };
  }

  elapsed(turn) {
    if (Number.isFinite(turn.elapsedMs)) return turn.elapsedMs;
    const time = Date.parse(turn.completedAt) - Date.parse(turn.createdAt);
    return time > 0 ? time : null;
  }

  durationLabel(ms) {
    if (ms === null) return "—";
    const seconds = Math.floor(ms / 1000);
    if (!seconds) return (ms / 1000).toFixed(1) + " 秒";
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return [hours ? `${hours} 小时` : "", minutes % 60 ? `${minutes % 60} 分钟` : "", `${seconds % 60} 秒`].filter(Boolean).join(" ");
  }

  updateProcessView(view, elapsed, usage, steps = [], reasoning = "") {
    if (!Array.isArray(steps)) steps = [];
    const { total, cacheRate } = this.runtime.core.usageMetrics(usage);
    const percent = cacheRate === null ? "—" : cacheRate.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 });
    const parts = [`用时 ${this.durationLabel(elapsed)}`, `${total === null ? "—" : total.toLocaleString()} Token`, `缓存命中 ${percent}`];
    if (view.metrics.dataset.values !== parts.join("|")) {
      view.metrics.dataset.values = parts.join("|");
      view.metrics.replaceChildren(...parts.map(value => this.element("span", "", value)));
    }
    for (const step of steps.slice(view.steps.childElementCount)) view.steps.append(this.element("li", "", step));
    view.steps.hidden = !steps.length;
    if (view.reasoning.textContent !== reasoning) view.reasoning.textContent = reasoning;
    view.reasoning.hidden = !reasoning;
    view.empty.textContent = view.details.dataset.state === "pending" ? "等待模型输出…" : "服务暂未提供模型工作步骤。";
    view.empty.hidden = !!reasoning || (view.details.dataset.state === "pending" && !steps.length);
  }

  updatePendingAnswer(view, task, turn) {
    const progress = task?.progress;
    const start = progress?.startedAt ?? Date.parse(turn?.createdAt);
    const container = this.ui.messages;
    const stick = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    this.updateProcessView(view, Number.isFinite(start) ? Math.max(0, Date.now() - start) : null,
      progress?.usage, progress?.steps, progress?.reasoning);
    view.answer.textContent = progress?.text || "";
    view.answer.hidden = !view.answer.textContent;
    if (progress?.text) view.empty.hidden = true;
    if (stick && view.details.isConnected) container.scrollTop = container.scrollHeight;
  }

  startBranch(turnID) {
    this.task = null;
    this.revision++;
    this.editingQuestion = null;
    this.selectedTurnID = turnID;
    this.render();
    this.ui.messages.scrollTop = this.ui.messages.scrollHeight;
    this.status("已选定分支起点，发送新问题后加入工作树。 ");
    this.ui.question.focus();
  }

  renderWorktree() {
    const container = this.ui.worktreeView;
    const paper = this.session?.paper;
    const item = this.context.supported ? this.context.item
      : paper && { libraryID: paper.libraryID, key: paper.itemKey };
    const records = item ? this.runtime.history.list({ item }).filter(record => record.turns.length) : [];
    const active = this.doc.activeElement;
    const focused = container.contains(active) ? active.dataset?.turnId : null;
    container.replaceChildren(this.element("h2", "aip-history-heading", "工作树"));
    if (!records.length) {
      container.append(this.element("p", "aip-meta", "这篇论文还没有会话。"));
      return;
    }
    let focusTarget;
    for (const record of records) {
      const tree = this.element("ul", "aip-conversation-tree");
      tree.setAttribute("data-conversation-id", record.id);
      const nodes = new Map();
      for (const [index, turn] of record.turns.entries()) {
        const node = this.element("li");
        const question = turn.question.replace(/\s+/g, " ").trim();
        const characters = Array.from(question);
        const label = characters.length > WORKTREE_LABEL_LENGTH
          ? characters.slice(0, WORKTREE_LABEL_LENGTH - 1).join("") + "…" : question;
        const button = this.element("button", "aip-tree-node");
        button.type = "button";
        button.dataset.turnId = turn.id;
        button.title = question;
        if (record.id === this.session?.id && turn.id === this.selectedTurnID) button.setAttribute("aria-current", "true");
        if (turn.state === "pending") {
          const dot = this.element("span", "aip-running-dot");
          dot.setAttribute("role", "img");
          dot.setAttribute("aria-label", "正在生成回答");
          button.append(dot);
        }
        button.append(this.element("span", "aip-tree-question", label));
        button.addEventListener("click", () => this.openSavedConversation(button, record.id, turn.id));
        node.append(button);
        const parent = nodes.get(this.runtime.core.turnParentID(record.turns, index));
        if (parent && !parent.children) {
          parent.children = this.element("ul");
          parent.node.append(parent.children);
        }
        (parent ? parent.children : tree).append(node);
        nodes.set(turn.id, { node, children: null });
        if (focused === turn.id) focusTarget = button;
      }
      container.append(tree);
    }
    focusTarget?.focus({ preventScroll: true });
  }

  async openSavedConversation(button, id, turnID) {
    if (this.openingConversation) return;
    this.openingConversation = true;
    button.disabled = true;
    try {
      const panel = await this.runtime.openConversation(id, this.win, turnID);
      if (panel !== this && !this.destroyed) {
        this.view = "chat";
        this.render();
      }
    }
    catch (error) { this.status(error.message, true); }
    finally {
      this.openingConversation = false;
      if (!this.destroyed) button.disabled = false;
    }
  }

  renderHistory() {
    const container = this.ui.historyView;
    container.replaceChildren(this.element("h2", "aip-history-heading", "历史会话"));
    const records = this.runtime.history.list();
    if (!records.length) container.append(this.element("p", "aip-meta", "暂无历史会话。"));
    if (this.runtime.history.unreadableCount) container.append(this.element("p", "aip-error", "部分历史文件无法读取，请检查本地会话文件。"));
    for (const record of records) {
      const button = this.element("button", "aip-history-entry");
      button.type = "button";
      button.setAttribute("data-conversation-id", record.id);
      if (this.session?.id === record.id) button.setAttribute("aria-current", "true");
      const heading = this.element("span", "aip-history-title-row");
      if (this.isRunning(record)) {
        const dot = this.element("span", "aip-running-dot");
        dot.setAttribute("role", "img");
        dot.setAttribute("aria-label", "正在生成回答");
        heading.append(dot);
      }
      if (record.pinned) {
        const pin = this.element("img", "aip-history-pin aip-toolbar-icon");
        pin.src = "chrome://zotero/skin/16/universal/pin.svg";
        pin.alt = "已置顶";
        heading.append(pin);
      }
      heading.append(this.element("span", "aip-history-paper", record.paper.title));
      button.append(heading,
        this.element("span", "aip-history-question", record.title),
        this.element("time", "aip-meta", new Date(record.updatedAt).toLocaleString())
      );
      button.addEventListener("contextmenu", event => this.openHistoryMenu(record, button, event));
      button.addEventListener("click", () => this.openSavedConversation(button, record.id));
      container.append(button);
    }
  }

  async send() {
    if (this.task || !this.context.supported || this.view !== "chat" || this.ui.send.disabled) return;
    const attachments = this.files.slice();
    const images = attachments.filter(file => file.kind === "image");
    const files = attachments.filter(file => file.kind !== "image");
    const draft = this.ui.question.value;
    const question = draft.trim() || (images.length ? "请结合当前论文分析所附图片。"
      : files.length ? "请结合当前论文分析添加的文件。" : "");
    if (!question) { this.ui.question.focus(); return; }
    await this.requestAnswer({
      conversationID: this.session?.id, parentTurnID: this.selectedTurnID, question, files, images,
      onStarted: () => {
        if (this.ui.question.value === draft) {
          this.ui.question.value = "";
          this.ui.question.style.height = "";
        }
        this.files = this.files.filter(file => !attachments.includes(file));
        this.renderFiles();
      },
      onError: error => {
        if (!error.conversation && !this.ui.question.value && !this.files.some(file => !attachments.includes(file))) {
          this.ui.question.value = draft;
          this.files = attachments;
          this.renderFiles();
          this.resizeQuestion();
        }
      }
    });
  }

  async resendQuestion(turn, editing) {
    if (this.editingQuestion !== editing || !this.context.supported || this.view !== "chat") return;
    const turns = this.session.turns;
    const index = turns.findIndex(entry => entry.id === turn.id);
    if (index === -1 || turns[index].state === "pending" || this.modelChange) {
      editing.sending = false;
      this.renderMessages();
      this.status("暂时无法重新发送这条提问，请稍后重试。", true);
      return;
    }
    const parentTurnID = this.runtime.core.turnParentID(turns, index);
    this.revision++;
    await this.requestAnswer({
      conversationID: parentTurnID === null ? undefined : this.session.id,
      parentTurnID, question: editing.text, files: turn.files, images: turn.images,
      onStarted: () => { this.editingQuestion = null; },
      onError: () => {
        if (this.editingQuestion !== editing) return;
        editing.sending = false;
        this.renderMessages();
        this.ui.messages.querySelector(".aip-edit-question")?.focus();
      }
    });
  }

  async requestAnswer({ conversationID, parentTurnID, question, files, images, onStarted, onError }) {
    const task = this.runtime.createTask();
    this.task = task;
    const revision = this.revision;
    const isCurrent = () => !this.destroyed && this.revision === revision && this.task === task;
    this.status("");
    this.updateControls();
    try {
      const record = await this.runtime.sendMessage(this.context, conversationID, question, task,
        (conversation, turnID) => {
          if (!isCurrent()) return;
          this.session = conversation;
          this.selectedTurnID = turnID;
          onStarted();
          this.render();
        }, files, parentTurnID, images);
      if (isCurrent()) {
        if (record) this.session = record;
        this.status("");
        this.render();
      }
    }
    catch (error) {
      if (isCurrent()) {
        this.status(error.message, true);
        onError(error);
      }
    }
    finally {
      if (this.task === task) {
        this.task = null;
        if (!this.destroyed) this.updateControls();
      }
    }
  }

  stop() {
    const task = this.task || Array.from(this.runtime.chatTasks).find(entry =>
      entry.conversationID === this.session?.id && entry.turnID === this.selectedTurnID);
    if (!task) return;
    task.cancelled = true;
    task.cancel?.();
  }

  async saveNote(turn, button) {
    button.disabled = true;
    const revision = this.revision;
    try {
      await this.runtime.saveNote(this.context, {
        text: turn.answer, source: turn.source, model: turn.model, skillName: turn.skillName,
        createdAt: turn.completedAt, question: turn.question
      });
      if (this.revision === revision) this.status("回答已保存到 Zotero 笔记。 ");
    }
    catch (error) { if (this.revision === revision) this.status(error.message, true); }
    finally { if (!this.destroyed) button.disabled = false; }
  }

  destroy() {
    this.destroyed = true;
    if (this.imageDialog?.dialog.open) this.imageDialog.dialog.close();
    this.hideTooltip();
    this.tooltip.remove();
    this.historyMenu.remove();
    this.noteMenu.remove();
    this.runtime.history.listeners.delete(this.onHistory);
    this.runtime.listeners.delete(this.onSettings);
    this.runtime.progressListeners.delete(this.onProgress);
    this.root.remove();
  }
};
