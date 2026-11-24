"use strict";

const CHAT_IMAGE_TYPES = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["webp", "image/webp"], ["gif", "image/gif"], ["bmp", "image/bmp"]
]);
const MAGPIE_CLIENT = "magpie-zotero-ai-paper";
const PLUGIN_NAME = "AiPluginForZotero";
// Keep the existing login realm so an installation over the old name can still read its API key.
const API_LOGIN_REALM = "AI论文插件";

var AIPaperRuntime = class {
  constructor(id, rootURI, version) {
    this.id = id;
    this.rootURI = rootURI;
    this.version = version;
    this.core = AIPaperCore;
    this.panels = new Map();
    this.listeners = new Set();
    this.pendingRequests = new Set();
    this.chatTasks = new Set();
    this.progressListeners = new Set();
    this.operations = new Set();
    this.layouts = new Map();
    this.windowLoads = new Map();
    this.readerStyles = new Map();
    this.macAppearance = new Map();
    this.readerSelection = new AIPaperReaderSelection(this);
    this.readerCapture = new AIPaperReaderCapture(this);
    this.onReaderToolbar = ({ doc, reader }) => {
      this.styleReaderToolbar(doc, reader);
      this.readerCapture.watch(reader, doc);
    };
    this.settingsQueue = Promise.resolve();
    this.alive = true;
    this.preferenceID = "ai-paper-preferences";
    this.preferenceKey = "extensions.zotero.aiPaper.settings";
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    this.cacheDirectory = PathUtils.join(profile, "ai-paper", "summaries");
    this.history = new AIPaperHistory(PathUtils.join(profile, "ai-paper", "conversations"));
  }

  async startup() {
    const readResource = filename => {
      const url = this.rootURI + `content/${filename}?v=` + encodeURIComponent(this.version);
      return Zotero.File.getResourceAsync ? Zotero.File.getResourceAsync(url) : Zotero.File.getResource(url);
    };
    const [readerToolbarCSS, macAppearanceCSS, skillText] = await Promise.all([
      readResource("reader-toolbar.css"), Zotero.isMac ? readResource("macos.css") : null, readResource("paper-reader.md")
    ]);
    this.readerToolbarCSS = readerToolbarCSS;
    this.macAppearanceCSS = macAppearanceCSS;
    this.defaultSkill = this.core.parseSkillText(skillText, "paper-reader.md", "paper-reader");
    await IOUtils.makeDirectory(this.cacheDirectory, { ignoreExisting: true, createAncestors: true });
    await this.migrateSkills();
    await this.history.init();
    await this.migrateSummaries();
    await Zotero.PreferencePanes.register({
      pluginID: this.id,
      id: this.preferenceID,
      label: PLUGIN_NAME,
      image: "chrome://zotero/skin/20/universal/note.svg",
      src: this.rootURI + "content/preferences.xhtml?v=" + encodeURIComponent(this.version),
      scripts: [this.rootURI + "content/preferences.js?v=" + encodeURIComponent(this.version)],
      stylesheets: [this.rootURI + "content/preferences.css?v=" + encodeURIComponent(this.version)]
    });
    this.windowObserver = {
      observe: (win, topic) => {
        if (topic === "domwindowopened") {
          const onLoad = () => {
            this.windowLoads.delete(win);
            this.attachWindow(win);
          };
          this.windowLoads.set(win, onLoad);
          win.addEventListener("load", onLoad, { once: true });
        }
        else if (topic === "domwindowclosed") {
          this.detachWindow(win);
          this.windowLoads.delete(win);
        }
      }
    };
    Services.ww.registerNotification(this.windowObserver);
    this.notifierID = Zotero.Notifier.registerObserver({
      notify: () => { for (const layout of this.layouts.values()) layout.scheduleUpdate(); }
    }, ["tab", "item"], "ai-paper-chat");
    Zotero.Reader.registerEventListener("renderToolbar", this.onReaderToolbar, this.id);
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this.readerSelection.onPopup, this.id);
    for (const reader of Zotero.Reader._readers ?? []) this.onReaderToolbar({ reader, doc: reader._iframeWindow?.document });
    for (const win of Services.wm.getEnumerator(null)) this.attachWindow(win);
    this.ready = true;
  }

  styleReaderToolbar(doc, reader) {
    if (!this.alive || !doc) return;
    doc = Cu.unwaiveXrays(doc);
    if (this.readerStyles.has(doc) || !doc.querySelector(".toolbar > .center.tools")) return;
    const win = doc.defaultView;
    const owner = reader?.tabID ? null : reader?._window;
    const root = doc.documentElement;
    const style = doc.createElement("style");
    style.id = "aip-reader-toolbar";
    style.textContent = [this.readerToolbarCSS, this.macAppearanceCSS].filter(Boolean).join("\n");
    const fit = reader?.type === "pdf" ? new AIPaperReaderFit(reader, doc) : null;
    const remove = event => {
      this.readerStyles.delete(doc);
      if (owner && !Cu.isDeadWrapper(owner)) owner.removeEventListener("unload", remove);
      this.readerSelection.detach(doc, !event);
      fit?.destroy(!event);
      if (Cu.isDeadWrapper(win) || Cu.isDeadWrapper(root)) return;
      win.removeEventListener("pagehide", remove);
      win.removeEventListener("unload", remove);
      root.classList.remove("aip-macos");
      style.remove();
    };
    this.readerStyles.set(doc, remove);
    win.addEventListener("pagehide", remove, { once: true });
    win.addEventListener("unload", remove, { once: true });
    owner?.addEventListener?.("unload", remove, { once: true });
    if (this.macAppearanceCSS) root.classList.add("aip-macos");
    doc.head.append(style);
  }

  styleMacAppearance(doc) {
    if (!this.macAppearanceCSS || !this.alive) return;
    doc = Cu.unwaiveXrays(doc);
    if (this.macAppearance.has(doc)) return;
    const root = doc.documentElement;
    const win = doc.defaultView;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "aip-macos-appearance";
    style.textContent = this.macAppearanceCSS;
    const remove = () => {
      this.macAppearance.delete(doc);
      if (Cu.isDeadWrapper(win) || Cu.isDeadWrapper(root)) return;
      win.removeEventListener("pagehide", remove);
      win.removeEventListener("unload", remove);
      root.classList.remove("aip-macos");
      style.remove();
    };
    this.macAppearance.set(doc, remove);
    win.addEventListener("pagehide", remove, { once: true });
    win.addEventListener("unload", remove, { once: true });
    root.classList.add("aip-macos");
    (doc.head || root).append(style);
  }

  attachWindow(win) {
    if (!this.alive || win.closed) return;
    const doc = win.document;
    if (doc.documentElement.id === "zotero-prefs") {
      this.styleMacAppearance(doc);
      return;
    }
    if (this.layouts.has(win) || !doc.getElementById("zotero-item-pane")) return;
    this.styleMacAppearance(doc);
    this.layouts.set(win, new AIPaperLayout(this, win));
  }

  detachWindow(win) {
    const layout = this.layouts.get(win);
    this.layouts.delete(win);
    layout?.destroy();
  }

  async readerComposer(reader, pageIndex) {
    if (!this.alive) return;
    const win = reader.tabID ? reader._window : Zotero.getMainWindow();
    const layout = this.layouts.get(win);
    if (!layout) return;
    if (reader.tabID && win.Zotero_Tabs.selectedID !== reader.tabID) return;
    if (!reader.tabID) {
      // A separate reader window has no chat pane. Open the same attachment in the main window.
      const tabID = win.Zotero_Tabs.getTabIDByItemID(reader.itemID);
      if (tabID) win.Zotero_Tabs.select(tabID, true, { location: { pageIndex } });
      else await Zotero.Reader.open(reader.itemID, { pageIndex }, { openInWindow: false, allowDuplicate: true });
      if (!this.alive || layout.destroyed) return;
      win.focus();
    }
    layout.update();
    const panel = layout.panels.get("reader");
    if (!panel?.context.supported || panel.context.attachment?.id !== reader.itemID) return;
    layout.expand("reader");
    if (panel.view !== "chat") { panel.view = "chat"; panel.render(); }
    panel.ui.question.focus({ preventScroll: true });
    return panel;
  }

  async addReaderSnapshot(reader, pageIndex, name, load) {
    const panel = await this.readerComposer(reader, pageIndex);
    if (panel?.context.attachment?.id === reader.itemID) await panel.addImages([{ name, load }]);
  }

  async addReaderQuote(reader, annotation, text) {
    const { pageIndex } = annotation.position;
    const page = annotation.pageLabel || String(pageIndex + 1);
    const quote = text.trim().split(/\r\n?|\n/).map(line => line ? `> ${line}` : ">").join("\n");
    if (!text.trim()) return;
    const panel = await this.readerComposer(reader, pageIndex);
    if (panel?.context.attachment?.id !== reader.itemID) return;
    const limited = this.core.limitText(quote, this.core.activeAPIProfile(this.getSettings()).api.contextChars);
    panel.addTextAttachment({ id: this.core.uniqueID(), name: `PDF 第 ${page} 页引用.md`, ...limited });
  }

  getSettings() {
    const saved = Zotero.Prefs.get(this.preferenceKey, true);
    if (!saved) return this.core.defaults(this.defaultSkill);
    let settings;
    try { settings = JSON.parse(saved); }
    catch (_) { throw new Error("AI论文配置无法解析，请在设置页重新导入配置。 "); }
    if (settings.schemaVersion !== 1 || !Array.isArray(settings.skills) || !settings.skills.length) {
      throw new Error("AI论文配置格式无效，请在设置页重新导入配置。 ");
    }
    Object.assign(settings, this.core.normalizeAPIProfiles(settings.apiProfiles, settings.activeAPIProfileID, settings.api));
    delete settings.api;
    settings.apiMode = settings.apiMode === "magpie" ? "magpie" : "direct";
    settings.magpie = this.core.validateMagpie(settings.magpie);
    settings.reading = this.core.validateReading(settings.reading);
    settings.skills = settings.skills.map(skill => this.core.validateSkill(skill));
    if (!settings.skills.some(skill => skill.id === settings.activeSkillID)) {
      settings.activeSkillID = settings.skills[0].id;
    }
    return settings;
  }

  async migrateSkills() {
    let settings;
    try { settings = this.getSettings(); }
    catch (error) { Zotero.logError(error); return; }
    const { skillSetVersion, skills, activeSkillID } = this.core.defaults(this.defaultSkill);
    if (settings.skillSetVersion >= skillSetVersion) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = PathUtils.join(PathUtils.parent(this.cacheDirectory), `skills-before-paper-reader-${timestamp}.json`);
    await IOUtils.writeJSON(backup, {
      schemaVersion: settings.schemaVersion, skills: settings.skills, activeSkillID: settings.activeSkillID
    }, { tmpPath: backup + ".tmp" });
    Zotero.Prefs.set(this.preferenceKey, JSON.stringify({ ...settings, skillSetVersion, skills, activeSkillID }), true);
  }

  apiLogins(id) {
    const realm = id === this.core.legacyAPIProfileID ? API_LOGIN_REALM : API_LOGIN_REALM + " / " + id;
    return { realm, entries: Services.logins.findLogins("chrome://zotero-ai-paper", null, realm) };
  }

  getAPIKey(id) {
    return this.apiLogins(id).entries[0]?.password || "";
  }

  async setAPIKey(id, key) {
    const { realm, entries } = this.apiLogins(id);
    if (!key) {
      for (const login of entries) Services.logins.removeLogin(login);
      return;
    }
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init("chrome://zotero-ai-paper", null, realm, "api", key, "", "");
    if (entries.length) Services.logins.modifyLogin(entries[0], login);
    else if (Services.logins.addLoginAsync) await Services.logins.addLoginAsync(login);
    else Services.logins.addLogin(login);
  }

  changeSettings(transform, credential, task) {
    const operation = this.settingsQueue.then(async () => {
      if (!this.alive) throw new Error("插件已停用。 ");
      if (task?.cancelled) throw new Error("模型列表获取已取消。 ");
      const next = transform(this.getSettings());
      let oldKey;
      const credentialID = credential && (credential.id ?? next.activeAPIProfileID);
      if (credentialID) {
        oldKey = this.getAPIKey(credentialID);
        if (credential.key !== oldKey) await this.setAPIKey(credentialID, credential.key);
      }
      try {
        if (task?.cancelled) throw new Error("模型列表获取已取消。 ");
        Zotero.Prefs.set(this.preferenceKey, JSON.stringify(next), true);
      }
      catch (error) {
        if (credentialID && credential.key !== oldKey) await this.setAPIKey(credentialID, oldKey);
        throw error;
      }
      for (const listener of this.listeners) {
        try { listener(); }
        catch (error) { Zotero.logError(error); }
      }
      return next;
    });
    this.settingsQueue = operation.catch(() => {});
    return operation;
  }

  saveAPI(id, name, raw, key, task) {
    const profile = this.core.validateAPIProfile({ id, name, api: raw });
    return this.changeSettings(settings => {
      if (settings.activeAPIProfileID !== id) throw new Error("API 配置已切换，请重新保存。");
      settings.apiProfiles = settings.apiProfiles.map(entry => entry.id === id ? profile : entry);
      return settings;
    }, { id, key: key.trim() }, task);
  }

  createAPIProfile() {
    const id = Services.uuid.generateUUID().toString().slice(1, -1);
    return this.changeSettings(settings => {
      let number = settings.apiProfiles.length + 1;
      const names = new Set(settings.apiProfiles.map(profile => profile.name));
      while (names.has("配置 " + number)) number++;
      settings.apiProfiles.push(this.core.validateAPIProfile({ id, name: "配置 " + number, api: {} }));
      settings.activeAPIProfileID = id;
      return settings;
    });
  }

  selectAPIProfile(id) {
    return this.changeSettings(settings => {
      if (!settings.apiProfiles.some(profile => profile.id === id)) throw new Error("找不到所选 API 配置。");
      settings.activeAPIProfileID = id;
      return settings;
    });
  }

  deleteAPIProfile(id) {
    return this.changeSettings(settings => {
      if (settings.activeAPIProfileID !== id) throw new Error("API 配置已切换，请重新选择。");
      if (settings.apiProfiles.length <= 1) throw new Error("请至少保留一套 API 配置。");
      settings.apiProfiles = settings.apiProfiles.filter(profile => profile.id !== id);
      settings.activeAPIProfileID = settings.apiProfiles[0].id;
      return settings;
    }, { id, key: "" });
  }

  saveAPIMode(mode) {
    return this.changeSettings(settings => ({ ...settings, apiMode: mode }));
  }

  modelPicker(settings = this.getSettings()) {
    if (settings.apiMode === "magpie") {
      const selected = new Set(settings.magpie.selected);
      return {
        mode: "magpie", model: settings.magpie.model,
        options: settings.magpie.models.filter(({ id }) => selected.has(id))
          .map(({ id, name, provider }) => ({ id, label: `${name} · ${provider}` }))
      };
    }
    const { id: profileID, name, api } = this.core.activeAPIProfile(settings);
    return { mode: "direct", profileID, name, model: api.model, options: api.models.map(id => ({ id, label: id })) };
  }

  selectModel(model, mode, profileID) {
    return this.changeSettings(settings => {
      if (mode && mode !== settings.apiMode) throw new Error("API 配置方式已切换，请重新选择模型。 ");
      if (settings.apiMode === "magpie") {
        if (!settings.magpie.selected.includes(model)) throw new Error("Magpie 模型未勾选，请重新选择。 ");
        return { ...settings, magpie: { ...settings.magpie, model } };
      }
      const profile = this.core.activeAPIProfile(settings);
      if (profileID && profileID !== profile.id) throw new Error("API 配置已切换，请重新选择模型。");
      if (!profile.api.models.includes(model)) throw new Error("模型列表已更新，请重新选择模型。 ");
      profile.api.model = model;
      return settings;
    });
  }

  async fetchModels(raw, key, task) {
    const api = this.core.validateAPI(raw, false);
    const data = await this.requestJSON("GET", this.core.modelsEndpoint(api.baseURL), {
      apiKey: key.trim(), timeoutSeconds: api.timeoutSeconds
    }, task);
    return this.core.readModels(data);
  }

  async importMagpie(task) {
    let port = this.core.magpiePort();
    try {
      const directory = Services.env.get("XDG_CONFIG_HOME") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".config");
      const config = await IOUtils.readJSON(PathUtils.join(directory, "magpie", "settings.json"));
      port = this.core.magpiePort(config?.port);
    }
    catch (_) { /* Magpie can run on the default port without a settings file. */ }
    const origin = await this.magpieOrigin(port, task);
    const data = await this.requestJSON("GET", origin + "/v1/models", {
      apiKey: MAGPIE_CLIENT, timeoutSeconds: 15, followRedirects: false
    }, task);
    const models = this.core.readMagpieModels(data);
    return this.changeSettings(settings => ({
      ...settings, magpie: this.core.validateMagpie({ ...settings.magpie, port, models })
    }), undefined, task);
  }

  async magpieOrigin(port, task) {
    const origin = `http://127.0.0.1:${port}`;
    let hello;
    try {
      hello = await this.requestJSON("GET", origin + "/api/hello", { timeoutSeconds: 5, followRedirects: false }, task);
    }
    catch (error) { if (task.cancelled) throw error; }
    if (hello?.name !== "magpie") throw new Error(`连不上本机 Magpie。请打开 Magpie，再到 ${PLUGIN_NAME} 设置中导入模型。 `);
    return origin;
  }

  toggleMagpieModel(id) {
    return this.changeSettings(settings => {
      const { magpie } = settings;
      if (!magpie.models.some(model => model.id === id)) throw new Error("Magpie 模型目录已更新，请重新选择。 ");
      const selected = magpie.selected.includes(id) ? magpie.selected.filter(model => model !== id) : [...magpie.selected, id];
      return { ...settings, magpie: this.core.validateMagpie({ ...magpie, selected }) };
    });
  }

  saveReading(raw) {
    const reading = this.core.validateReading(raw);
    return this.changeSettings(settings => ({ ...settings, reading }));
  }

  saveSkill(raw, makeDefault) {
    const skill = this.core.validateSkill(raw);
    return this.changeSettings(settings => {
      const index = settings.skills.findIndex(entry => entry.id === skill.id);
      if (index >= 0) settings.skills[index] = skill;
      else settings.skills.push(skill);
      if (makeDefault) settings.activeSkillID = skill.id;
      return settings;
    });
  }

  deleteSkill(id) {
    return this.changeSettings(settings => {
      if (settings.skills.length <= 1) throw new Error("请至少保留一个 Skill。 ");
      settings.skills = settings.skills.filter(skill => skill.id !== id);
      if (settings.activeSkillID === id) settings.activeSkillID = settings.skills[0].id;
      return settings;
    });
  }

  async importFile(win, kind = "config") {
    const path = await this.pickFile(win, kind === "skill" ? "导入 Skill" : "导入 API / 插件配置", false,
      kind === "skill" ? "*.md; *.txt; *.json" : "*.json");
    if (!path) return null;
    const stat = await IOUtils.stat(path);
    if (stat.size > 2 * 1024 * 1024) throw new Error("配置文件超过 2 MB，请检查选择的文件。 ");
    const text = await IOUtils.readUTF8(path);
    let imported;
    if (kind === "skill" && !/\.json$/i.test(path)) {
      imported = { skills: [this.core.parseSkillText(text, PathUtils.filename(path))] };
    }
    else imported = this.core.parseImport(text);
    if (kind === "skill") {
      if (!imported.skills) throw new Error("所选文件中没有 Skill，请选择包含提示词的文件。 ");
      imported = { skills: imported.skills };
    }
    const credential = imported.apiKey === undefined ? undefined : { key: imported.apiKey };
    await this.changeSettings(settings => {
      for (const profile of imported.apiProfiles || []) {
        const existing = settings.apiProfiles.find(entry => entry.id === profile.id);
        if (existing && new URL(existing.api.baseURL).origin !== new URL(profile.api.baseURL).origin && this.getAPIKey(profile.id)) {
          throw new Error(`配置「${existing.name}」的服务地址不同，请在设置中单独编辑该配置。`);
        }
      }
      return this.core.mergeImport(settings, imported);
    }, credential);
    return imported;
  }

  async exportConfig(win) {
    const path = await this.pickFile(win, "导出配置", true, "*.json", "ai-paper-config.json");
    if (!path) return false;
    const settings = this.getSettings();
    const data = { ...settings, api: this.core.activeAPIProfile(settings).api };
    await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2), { tmpPath: path + ".tmp" });
    return true;
  }

  async pickFile(win, title, save, filter, filename, multiple = false) {
    let FilePicker;
    try { ({ FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs")); }
    catch (_) { ({ FilePicker } = ChromeUtils.import("chrome://zotero/content/modules/filePicker.jsm")); }
    const picker = new FilePicker();
    picker.init(win, title, multiple ? picker.modeOpenMultiple : save ? picker.modeSave : picker.modeOpen);
    picker.appendFilter(multiple ? "PDF、文本与图片" : "配置文件", filter);
    picker.appendFilters(picker.filterAll);
    if (filename) { picker.defaultString = filename; picker.defaultExtension = "json"; }
    const result = await picker.show();
    if (result === picker.returnCancel) return multiple ? [] : null;
    return multiple ? picker.files : picker.file;
  }

  pickChatFiles(win) {
    const images = [...CHAT_IMAGE_TYPES.keys()].map(extension => `*.${extension}`);
    const filter = ["*.pdf", "*.txt", "*.md", "*.markdown", "*.csv", "*.tsv", "*.json", "*.tex", ...images].join(";");
    return this.pickFile(win, "添加文件", false, filter, undefined, true);
  }

  chatImageType(path) {
    return CHAT_IMAGE_TYPES.get(PathUtils.filename(path).split(".").at(-1).toLowerCase());
  }

  async readChatFile(path) {
    const name = PathUtils.filename(path);
    let text;
    if (/\.pdf$/i.test(name)) {
      try {
        const result = await Zotero.PDFWorker._enqueue(async () => {
          const bytes = await IOUtils.read(path);
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const action = Zotero.PDFWorker.getFullText.toString().includes("pdf.getFulltext") ? "pdf.getFulltext" : "getFulltext";
          return Zotero.PDFWorker._query(action, { buf, maxPages: null }, [buf]);
        }, true);
        text = result?.text;
      }
      catch (_) { throw new Error(`${name} 的 PDF 文本提取失败，请检查文件是否加密或需要 OCR。`); }
    }
    else if (/\.(txt|md|markdown|csv|tsv|json|tex)$/i.test(name)) text = await IOUtils.readUTF8(path);
    else throw new Error(`${name} 的格式暂无法读取。可添加 PDF、TXT、Markdown、CSV、TSV、JSON 或 TeX 文件。`);
    if (!text?.trim()) throw new Error(`${name} 没有可提取的文本。`);
    const limited = this.core.limitText(text.trim(), this.core.activeAPIProfile(this.getSettings()).api.contextChars);
    return { id: this.core.uniqueID(), path, name, ...limited };
  }

  async deleteConversation(id) {
    for (const task of this.chatTasks) {
      if (task.conversationID === id) { task.cancelled = true; task.cancel?.(); }
    }
    if (/^legacy-\d+-[A-Z0-9]{8}-(main|[A-Z0-9]{8})$/.test(id)) {
      await IOUtils.remove(PathUtils.join(this.cacheDirectory, id.slice(7) + ".json"), { ignoreAbsent: true });
    }
    await this.history.remove(id);
  }

  contextForItem(selected) {
    const attachment = selected?.isPDFAttachment() ? selected : null;
    const item = attachment?.parentID ? Zotero.Items.get(attachment.parentID) : selected;
    const supported = !!item && !item.deleted && (item.isRegularItem() || !!attachment);
    const key = supported ? `${item.libraryID}-${item.key}-${attachment?.key || "main"}` : "";
    return { item, attachment, supported, key };
  }

  async migrateSummaries() {
    for (const path of await IOUtils.getChildren(this.cacheDirectory)) {
      const match = PathUtils.filename(path).match(/^(\d+)-([A-Z0-9]{8})-(main|[A-Z0-9]{8})\.json$/);
      if (!match) continue;
      const id = "legacy-" + PathUtils.filename(path).replace(/\.json$/, "");
      if (this.history.records.has(id)) continue;
      try {
        const result = await IOUtils.readJSON(path);
        if (typeof result.text !== "string") continue;
        const libraryID = Number(match[1]);
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, match[2]);
        if (item) await item.loadDataType("itemData");
        await this.history.importLegacy(id, {
          libraryID, itemKey: match[2], attachmentKey: match[3] === "main" ? null : match[3],
          title: item?.getField("title") || "历史论文"
        }, result);
      }
      catch (error) { Zotero.logError(error); }
    }
  }

  sendMessage(context, conversationID, question, task, onStart, files = [], parentTurnID, images = []) {
    const operation = this.answer(context, conversationID, question, task, onStart, files, parentTurnID, images);
    this.operations.add(operation);
    operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }

  updateProgress(task, step, chunk) {
    if (!this.alive || task.cancelled) return;
    if (step && task.progress.steps.at(-1) !== step) task.progress.steps.push(step);
    if (chunk) Object.assign(task.progress, chunk);
    for (const listener of this.progressListeners) {
      try { listener(task); }
      catch (error) { Zotero.logError(error); }
    }
  }

  async answer(context, conversationID, question, task, onStart, files, parentTurnID, images) {
    task.progress = { startedAt: Date.now(), steps: [], text: "", reasoning: "", usage: null };
    const stage = step => this.updateProgress(task, step);
    const progressResult = () => ({
      elapsedMs: Math.max(0, Date.now() - task.progress.startedAt),
      process: { steps: task.progress.steps.slice(), reasoning: task.progress.reasoning }
    });
    this.chatTasks.add(task);
    let started;
    try {
      if (!this.alive || !context.supported) throw new Error("请先选择一篇论文。 ");
      question = String(question).trim();
      if (!question || question.length > 5000) throw new Error("问题须为 1–5000 个字符。 ");
      await this.settingsQueue;
      const settings = this.getSettings();
      const profile = this.core.activeAPIProfile(settings);
      let api = profile.api;
      let key;
      if (settings.apiMode === "magpie") {
        const { model, selected, port } = settings.magpie;
        if (!model) throw new Error("请在设置中勾选要使用的 Magpie 模型。 ");
        const origin = await this.magpieOrigin(port, task);
        api = { ...api, baseURL: origin + "/v1", model, models: selected, localMagpie: true };
        key = MAGPIE_CLIENT;
      }
      else key = this.getAPIKey(profile.id);
      this.core.validateAPI(api);
      files = this.core.prepareFiles(files, api.contextChars);
      images = this.core.prepareImages(images);
      const skill = settings.skills.find(entry => entry.id === settings.activeSkillID);
      started = await this.history.begin(context, conversationID, question, files, parentTurnID, images);
      task.conversationID = started.conversation.id;
      task.turnID = started.turnID;
      onStart(started.conversation, started.turnID);
      if (task.cancelled) return await this.history.finish(task.conversationID, task.turnID, {}, task);
      stage("读取论文资料");
      const paper = await this.paper(context, settings.reading.mode, api.contextChars, stage);
      if (files.length) paper.source += ` · 补充文件 ${files.length} 个${files.some(file => file.truncated) ? "（已节选）" : ""}`;
      if (images.length) paper.source += ` · 附图 ${images.length} 张`;
      if (task.cancelled) return await this.history.finish(task.conversationID, task.turnID, {}, task);
      stage("向模型发送提问");
      const ancestors = this.core.turnPath(started.conversation.turns, started.turnID).slice(0, -1);
      const completion = await this.complete(api, key,
        this.core.chatMessages(paper, skill, ancestors, question, settings.reading.historyChars, files, images), task,
        chunk => {
          const firstOutput = (chunk.text || chunk.reasoning) && !task.progress.text && !task.progress.reasoning;
          this.updateProgress(task, firstOutput ? "接收模型输出" : null, chunk);
        }, stage);
      task.progress.reasoning = completion.reasoning || task.progress.reasoning;
      stage("已收到模型回答");
      return await this.history.finish(task.conversationID, task.turnID, {
        state: "complete", answer: completion.text, source: paper.source,
        model: api.model, skillName: skill.name, skillID: skill.id,
        usage: completion.usage, outputTruncated: completion.truncated,
        ...progressResult(),
        attachmentKey: paper.attachmentKey || context.attachment?.key || null
      }, task);
    }
    catch (error) {
      if (error.conversation) throw error;
      if (started) {
        await this.history.finish(task.conversationID, task.turnID,
          { state: "error", answer: null, errorMessage: error.message, ...progressResult() }, task);
      }
      if (!task.cancelled) throw error;
      return started && this.history.records.has(task.conversationID) ? this.history.get(task.conversationID) : null;
    }
    finally { this.chatTasks.delete(task); }
  }

  async openConversation(id, sourceWindow, turnID) {
    let conversation = this.history.get(id);
    const win = sourceWindow?.ZoteroPane ? sourceWindow : Zotero.getMainWindow();
    const layout = this.layouts.get(win);
    if (!layout) throw new Error("请先打开 Zotero 主窗口。 ");
    const item = await Zotero.Items.getByLibraryAndKeyAsync(conversation.paper.libraryID, conversation.paper.itemKey);
    if (!item || item.deleted) {
      const type = win.Zotero_Tabs.selectedType === "library" ? "library" : "reader";
      const panel = layout.panels.get(type);
      panel.openRecord(conversation, this.contextForItem(null), turnID);
      panel.status("对应论文已被删除或移入回收站，请先恢复论文。", true);
      return panel;
    }
    await item.loadAllData();
    win.focus();
    let attachment = conversation.paper.attachmentKey && await Zotero.Items.getByLibraryAndKeyAsync(
      conversation.paper.libraryID, conversation.paper.attachmentKey);
    if (!attachment?.isPDFAttachment() || attachment.deleted || (attachment.parentID && attachment.parentID !== item.id)) {
      attachment = item.isPDFAttachment() ? item : item.isRegularItem() ? await item.getBestAttachment() : null;
    }
    let type = "library";
    if (attachment?.isPDFAttachment() && !attachment.deleted && await attachment.getFilePathAsync()) {
      await Zotero.Reader.open(attachment.id);
      type = "reader";
    }
    else {
      win.Zotero_Tabs.select("zotero-pane");
      await win.ZoteroPane.selectItem(item.id);
    }
    layout.update();
    layout.expand(type);
    conversation = this.history.get(id);
    const panel = layout.panels.get(type);
    panel.openRecord(conversation, this.contextForItem(type === "reader" ? attachment : item), turnID);
    return panel;
  }

  metadata(item) {
    const field = name => item.isRegularItem() ? String(item.getField(name) || "") : "";
    const creators = item.isRegularItem() ? item.getCreators().map(creator =>
      [creator.firstName, creator.lastName].filter(Boolean).join(" ")).join(", ") : "";
    return [
      "标题 " + (item.getField("title") || "未命名"),
      creators && "作者 " + creators,
      field("date") && "日期 " + field("date"),
      field("publicationTitle") && "刊物 " + field("publicationTitle"),
      field("DOI") && "DOI " + field("DOI")
    ].filter(Boolean).join("\n");
  }

  async paper(context, mode, maxChars, onProgress) {
    const { item } = context;
    const abstract = item.isRegularItem() ? Zotero.Utilities.unescapeHTML(
      String(item.getField("abstractNote") || "").replace(/<[^>]*>/g, " ")
    ).trim() : "";
    let text = "";
    let source = "";
    let fallbackReason = "";
    let attachmentKey = null;
    if (mode !== "abstract") {
      const candidates = context.attachment ? [context.attachment] : [];
      if (!context.attachment && item.isRegularItem()) {
        const best = await item.getBestAttachment();
        if (best?.isPDFAttachment()) candidates.push(best);
        for (const id of item.getAttachments()) {
          const attachment = Zotero.Items.get(id);
          if (attachment?.isPDFAttachment() && !candidates.some(entry => entry.id === id)) candidates.push(attachment);
        }
      }
      fallbackReason = candidates.length ? "PDF 无可提取文本或文件尚未下载" : "条目没有 PDF 附件";
      for (const attachment of candidates) {
        if (attachment.deleted || !(await attachment.getFilePathAsync())) continue;
        onProgress("提取 PDF 全文");
        try {
          const result = await Zotero.PDFWorker.getFullText(attachment.id, null, true);
          if (result?.text?.trim()) {
            text = result.text.trim();
            attachmentKey = attachment.key;
            source = `PDF 全文 · ${attachment.getField("title") || attachment.key}`;
            if (result.totalPages) source += ` · ${result.totalPages} 页`;
            break;
          }
        }
        catch (_) { fallbackReason = "PDF 提取失败，可能需要解密或 OCR"; }
      }
    }
    if (!text) {
      if (mode === "fulltext") throw new Error(`${fallbackReason}。可在 ${PLUGIN_NAME} 设置中切换为摘要模式。 `);
      if (!abstract) throw new Error("没有可用的 PDF 文本或摘要。请添加可选中文字的 PDF，或补充条目摘要。 ");
      onProgress("读取条目摘要");
      text = abstract;
      source = mode === "abstract" ? "仅条目摘要" : "仅条目摘要 · " + fallbackReason;
    }
    const limited = this.core.limitText(text, maxChars);
    if (limited.truncated) source += ` · 已节选，原文 ${limited.totalChars} 字符，上限 ${maxChars}`;
    const abstractContext = source.startsWith("PDF") && abstract ? "\n摘要 " + abstract : "";
    return { text: limited.text, source, metadata: this.metadata(item) + abstractContext, truncated: limited.truncated, attachmentKey };
  }

  createTask() {
    return { cancelled: false, cancel: null };
  }

  async complete(api, key, messageList, task, onChunk, onStage) {
    const followRedirects = !api.localMagpie;
    api = this.core.validateAPI(api);
    const url = this.core.endpoint(api.baseURL);
    const options = { apiKey: key, timeoutSeconds: api.timeoutSeconds, followRedirects };
    const nonStreaming = async () => this.core.readResponse(await this.requestJSON("POST", url, {
      ...options, body: this.core.requestBody(api, messageList)
    }, task));
    if (!onChunk) return nonStreaming();

    const streaming = async includeUsage => {
      const parser = this.core.completionStream(onChunk);
      const isStream = response => /^text\/event-stream\b/i.test(response.getResponseHeader("Content-Type") || "")
        || /^\s*(?:data:|event:|:)/.test(response.responseText);
      const response = await this.requestHTTP("POST", url, {
        ...options, accept: "text/event-stream, application/json",
        body: this.core.requestBody(api, messageList, true, includeUsage),
        onProgress: xhr => {
          if (!task.cancelled && xhr.status >= 200 && xhr.status < 300 && isStream(xhr)) parser.read(xhr.responseText);
        }
      }, task);
      if (response.status < 200 || response.status >= 300 || !isStream(response)) {
        return this.core.readResponse(this.parseJSON(response, key));
      }
      parser.read(response.responseText, true);
      if (parser.apiError) throw this.responseError(response.status, parser.apiError, key);
      return parser.result();
    };

    // Retry only when the server explicitly rejects streaming options before generation.
    const rejects = (error, option) => [400, 422, 501].includes(error.status) && option.test(error.message)
      && /unsupported|not support|not allowed|not implemented|unknown|unrecognized|unexpected|extra|不支持|未知/i.test(error.message);
    try { return await streaming(true); }
    catch (error) {
      if (task.cancelled) throw error;
      if (rejects(error, /stream_options|include_usage/i)) {
        onStage("改用基础流式请求");
        try { return await streaming(false); }
        catch (basicError) { error = basicError; }
      }
      if (!task.cancelled && rejects(error, /\bstream(?:ing)?\b|流式/)) {
        onStage("改用一次性响应");
        return nonStreaming();
      }
      throw error;
    }
  }

  async requestHTTP(method, url, { apiKey, timeoutSeconds, body, accept = "application/json", followRedirects = true, onProgress }, task) {
    if (task.cancelled) throw new Error("已停止。 ");
    const headers = { Accept: accept };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    this.pendingRequests.add(task);
    let response;
    try {
      response = await Zotero.HTTP.request(method, url, {
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        responseType: "text",
        timeout: timeoutSeconds * 1000,
        successCodes: false,
        errorDelayMax: 0,
        logBodyLength: 0,
        anon: true,
        followRedirects,
        requestObserver: onProgress ? xhr => xhr.addEventListener("progress", () => onProgress(xhr)) : undefined,
        cancellerReceiver: cancel => {
          task.cancel = cancel;
          if (task.cancelled) cancel();
        }
      });
    }
    catch (error) {
      if (task.cancelled) throw new Error("已停止。 ");
      const isTimeout = error?.name?.includes("Timeout") || /timed out|timeout/i.test(error?.message || "");
      throw new Error(isTimeout ? "请求超时，可在设置中增加超时秒数后重试。 " : "连接失败，请检查 API 地址、网络或代理设置。 ");
    }
    finally { this.pendingRequests.delete(task); task.cancel = null; }
    if (task.cancelled) throw new Error("已停止。 ");
    return response;
  }

  async requestJSON(method, url, options, task) {
    return this.parseJSON(await this.requestHTTP(method, url, options, task), options.apiKey);
  }

  parseJSON(response, apiKey) {
    let data;
    try { data = JSON.parse(response.responseText); }
    catch (_) {
      throw new Error(`API 返回 HTTP ${response.status}，响应不是有效 JSON，请检查接口地址。`);
    }
    if (response.status < 200 || response.status >= 300 || data?.error) {
      throw this.responseError(response.status, data, apiKey);
    }
    return data;
  }

  responseError(status, data, apiKey) {
    const hints = {
      401: "API Key 无效或未填写", 403: "权限不足，请检查账户或模型权限", 404: "接口或模型不存在",
      429: "请求受限或额度不足", 500: "服务端错误", 502: "网关错误", 503: "模型服务暂不可用"
    };
    let detail = String(data?.error?.message || data?.message || "");
    if (apiKey) detail = detail.split(apiKey).join("[已隐藏密钥]");
    detail = detail.replace(/\bsk-[A-Za-z0-9_-]+/g, "[已隐藏密钥]").slice(0, 350);
    const error = new Error(`HTTP ${status} · ${hints[status] || "请求失败"}${detail ? "\n" + detail : ""}`);
    error.status = status;
    return error;
  }

  async saveNote(context, result) {
    const item = context.item;
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library?.editable) throw new Error("当前文库为只读，无法保存笔记。 ");
    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    if (item.isRegularItem()) note.parentID = item.id;
    const escape = this.core.escapeHTML;
    note.setNote(`<div data-schema-version="9"><h1>AI论文问答</h1><p>${escape(item.getField("title"))}</p>`
      + `<p>${escape(result.source)}<br/>${escape(result.model)} · ${escape(result.skillName)}<br/>${escape(result.createdAt)}</p>`
      + (result.question ? `<h2>${escape(result.question)}</h2>` : "")
      + this.core.markdownHTML(result.text, { note: true }) + "</div>");
    return note.saveTx();
  }

  async shutdown() {
    this.alive = false;
    for (const task of this.chatTasks) { task.cancelled = true; task.cancel?.(); }
    for (const task of this.pendingRequests) { task.cancelled = true; task.cancel?.(); }
    Services.ww.unregisterNotification(this.windowObserver);
    Zotero.Notifier.unregisterObserver(this.notifierID);
    Zotero.Reader.unregisterEventListener("renderToolbar", this.onReaderToolbar);
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this.readerSelection.onPopup);
    this.readerCapture.destroy();
    for (const remove of this.readerStyles.values()) remove();
    for (const remove of this.macAppearance.values()) remove();
    for (const [win, listener] of this.windowLoads) win.removeEventListener("load", listener);
    this.windowLoads.clear();
    for (const layout of this.layouts.values()) layout.destroy();
    this.layouts.clear();
    this.panels.clear();
    this.listeners.clear();
    this.progressListeners.clear();
    Zotero.PreferencePanes.unregister(this.preferenceID);
    await Promise.allSettled([...this.operations, this.settingsQueue]);
    await this.history.queue;
    try { await this.history.flush(); }
    catch (error) { Zotero.logError(error); }
    this.history.listeners.clear();
  }
};
