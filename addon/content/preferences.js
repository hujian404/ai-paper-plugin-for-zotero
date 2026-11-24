"use strict";

window.AIPaperPreferences = {
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.runtime = Zotero.AIPaper;
    this.doc = document;
    this.skillDrafts = new Map();
    this.models = [];
    this.magpieButtons = new Map();
    this.expandedProviders = new Set();
    this.apiFields = ["baseURL", "model", "contextChars", "timeoutSeconds", "maxTokens", "tokenParameter", "temperature"];
    const root = this.element("root");
    const fields = root.querySelectorAll(".aip-pref-field-row > :is(input, select)");
    for (const field of fields) {
      const event = field.localName === "select" ? "change" : "input";
      field.addEventListener(event, () => this.fitField(field));
    }
    root.addEventListener("showing", () => {
      window.requestAnimationFrame(() => {
        if (this.destroyed) return;
        for (const field of fields) this.fitField(field);
      });
    });
    this.bind("saveReading", "reading", async () => {
      await this.runtime.saveReading({
        mode: this.element("readingMode").value,
        historyChars: this.element("historyChars").value,
        keepNativeSidebar: this.element("keepNativeSidebar").checked
      });
      this.status("reading", "论文问答设置已保存。 ");
    });
    this.bind("directMode", "api", () => this.runtime.saveAPIMode("direct"));
    this.bind("magpieMode", "api", () => this.runtime.saveAPIMode("magpie"));
    this.bind("importMagpie", "api", async () => {
      const task = this.runtime.createTask();
      this.magpieTask = task;
      this.status("api", "正在读取本机 Magpie 的模型目录…");
      try {
        const { magpie } = await this.runtime.importMagpie(task);
        if (this.destroyed || task.cancelled) return;
        const providers = new Set(magpie.models.map(model => model.provider)).size;
        this.status("api", magpie.models.length
          ? `已导入 ${providers} 家供应商的 ${magpie.models.length} 个模型。`
          : "Magpie 暂无已启用的对话模型。请在 Magpie 中启用模型后重新导入。");
      }
      catch (error) { if (!task.cancelled) throw error; }
      finally { if (this.magpieTask === task) this.magpieTask = null; }
    });
    this.bind("saveAPI", "api", async () => {
      this.cancelModelFetch();
      await this.runtime.saveAPI(this.readAPI(false), this.element("apiKey").value);
      this.modelDirty = false;
      this.status("api", "API 配置已保存。 ");
    });
    this.bind("fetchModels", "api", async () => {
      const api = this.readAPI(false);
      const key = this.element("apiKey").value.trim();
      const task = this.runtime.createTask();
      this.modelTask = task;
      this.element("fetchModels").textContent = "正在获取…";
      this.status("api", "正在请求模型列表…");
      try {
        const models = await this.runtime.fetchModels(api, key, task);
        if (this.destroyed || task.cancelled) return;
        const current = this.readAPI(false);
        if (this.runtime.core.modelsEndpoint(current.baseURL) !== this.runtime.core.modelsEndpoint(api.baseURL)
            || key !== this.element("apiKey").value.trim()) return;
        const model = models.includes(current.model) ? current.model : "";
        await this.runtime.saveAPI({ ...current, model, models }, key, task);
        if (this.destroyed || task.cancelled) return;
        this.models = models;
        this.modelDirty = false;
        this.modelsSource = this.runtime.core.modelsEndpoint(current.baseURL);
        this.renderModels(model);
        this.status("api", `已获取 ${models.length} 个模型，侧栏模型列表已同步。`);
      }
      catch (error) { if (!task.cancelled) throw error; }
      finally {
        if (this.modelTask === task) this.modelTask = null;
        if (!this.destroyed) this.element("fetchModels").textContent = "获取模型列表";
      }
    });
    this.element("baseURL").addEventListener("input", () => {
      this.cancelModelFetch();
      let sameSource = false;
      try { sameSource = this.runtime.core.modelsEndpoint(this.element("baseURL").value) === this.modelsSource; }
      catch (_) {}
      if (!sameSource) { this.models = []; this.renderModels(""); }
    });
    this.element("apiKey").addEventListener("input", () => this.cancelModelFetch());
    this.element("model").addEventListener("change", () => {
      this.modelDirty = true;
      this.element("testAPI").disabled = !this.element("model").value;
    });
    this.bind("testAPI", "api", async () => {
      const task = this.testTask = this.runtime.createTask();
      this.status("api", "正在测试连接，测试会发送一条简短请求。 ");
      try {
        const result = await this.runtime.complete(this.readAPI(), this.element("apiKey").value.trim(),
          [{ role: "user", content: "Reply with OK." }], task);
        if (!task.cancelled) this.status("api", "连接成功 · " + result.text.slice(0, 100));
      }
      catch (error) { if (!task.cancelled) throw error; }
      finally { if (this.testTask === task) this.testTask = null; }
    });
    this.element("showKey").addEventListener("click", () => {
      const input = this.element("apiKey");
      input.type = input.type === "password" ? "text" : "password";
      this.element("showKey").textContent = input.type === "password" ? "显示" : "隐藏";
      this.fitField(input);
    });
    this.element("skill").addEventListener("change", () => {
      this.rememberDraft();
      this.loadSkill(this.element("skill").value);
    });
    this.bind("newSkill", "skill", async () => {
      this.rememberDraft();
      const skill = { id: this.runtime.core.uniqueID(), name: "新建 Skill", prompt: "" };
      this.skillDrafts.set(skill.id, { ...skill, makeDefault: false });
      this.renderSkillList(skill.id);
      this.loadSkill(skill.id);
      this.element("skillName").focus();
      this.element("skillName").select();
    });
    this.bind("saveSkill", "skill", async () => {
      const skill = this.readSkill();
      await this.runtime.saveSkill(skill, this.element("makeDefault").checked);
      this.skillDrafts.delete(skill.id);
      this.renderSkillList(skill.id);
      this.loadSkill(skill.id);
      this.status("skill", "Skill 已保存。 ");
    });
    this.bind("deleteSkill", "skill", async () => {
      const id = this.skillID;
      if (this.runtime.getSettings().skills.some(skill => skill.id === id)) {
        await this.runtime.deleteSkill(id);
      }
      this.skillDrafts.delete(id);
      this.renderSkillList();
      this.loadSkill(this.element("skill").value);
      this.status("skill", "Skill 已删除。 ");
    });
    this.bind("importSkill", "skill", async () => {
      this.rememberDraft();
      const imported = await this.runtime.importFile(window, "skill");
      if (!imported) return;
      const firstID = imported.skills?.[0]?.id;
      if (firstID) this.skillDrafts.delete(firstID);
      this.renderSkillList(firstID);
      this.loadSkill(this.element("skill").value);
      this.status("skill", "Skill 已导入。 ");
    });
    this.bind("importConfig", "import", async () => {
      this.cancelAPIRequests();
      const imported = await this.runtime.importFile(window);
      if (!imported) return;
      this.skillDrafts.clear();
      this.loadAPI();
      this.syncAPI();
      this.loadReading();
      this.renderSkillList();
      this.loadSkill(this.element("skill").value);
      this.status("import", "配置已导入。 ");
    });
    this.bind("exportConfig", "import", async () => {
      if (await this.runtime.exportConfig(window)) this.status("import", "已导出保存过的配置，API Key 已省略。 ");
    });
    try {
      this.loadAPI();
      this.syncAPI();
      this.loadReading();
      this.renderSkillList();
      this.loadSkill(this.element("skill").value);
    }
    catch (error) { this.status("api", error.message, true); }
    this.onSettings = () => this.syncAPI();
    this.runtime.listeners.add(this.onSettings);
  },

  element(name) { return this.doc.getElementById("aip-pref-" + name); },

  destroy() {
    this.destroyed = true;
    this.runtime.listeners.delete(this.onSettings);
    this.cancelAPIRequests();
    this.element("apiKey").value = "";
    delete window.AIPaperPreferences;
  },

  status(group, message, error = false) {
    if (this.destroyed) return;
    const element = this.element(group + "Status");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("aip-pref-error", error);
  },

  bind(name, group, action) {
    const button = this.element(name);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await action(); }
      catch (error) { this.status(group, error.message, true); }
      finally { if (!this.destroyed) button.disabled = false; }
    });
  },

  loadAPI() {
    const api = this.runtime.getSettings().api;
    for (const name of this.apiFields) {
      const field = this.element(name);
      field.value = api[name];
      if (field.parentElement.classList.contains("aip-pref-field-row")) this.fitField(field);
    }
    this.models = api.models;
    this.modelDirty = false;
    this.modelsSource = this.runtime.core.modelsEndpoint(api.baseURL);
    this.renderModels(api.model);
    const key = this.element("apiKey");
    key.value = this.runtime.getAPIKey();
    this.fitField(key);
  },

  readAPI(requireModel = true) {
    return this.runtime.core.validateAPI({
      ...Object.fromEntries(this.apiFields.map(field => [field, this.element(field).value])), models: this.models
    }, requireModel);
  },

  cancelModelFetch() {
    if (this.modelTask) { this.modelTask.cancelled = true; this.modelTask.cancel?.(); }
  },

  cancelAPIRequests() {
    this.cancelModelFetch();
    for (const task of [this.testTask, this.magpieTask]) {
      if (task) { task.cancelled = true; task.cancel?.(); }
    }
  },

  syncAPI() {
    if (this.destroyed) return;
    const { api, apiMode, magpie } = this.runtime.getSettings();
    const viaMagpie = apiMode === "magpie";
    if (this.apiMode !== apiMode) {
      this.cancelAPIRequests();
      this.status("api", "");
      this.apiMode = apiMode;
      this.element("directMode").setAttribute("aria-pressed", String(!viaMagpie));
      this.element("magpieMode").setAttribute("aria-pressed", String(viaMagpie));
      this.element("directPanel").hidden = viaMagpie;
      this.element("magpiePanel").hidden = !viaMagpie;
    }
    if (viaMagpie) this.renderMagpie(magpie);
    else this.syncModels(api);
  },

  renderMagpie({ models, selected }) {
    const table = this.element("magpieCatalog");
    const catalog = JSON.stringify(models);
    if (catalog !== this.magpieCatalog) {
      this.magpieCatalog = catalog;
      this.magpieButtons.clear();
      const fragment = this.doc.createDocumentFragment();
      const html = tag => this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      const groups = new Map();
      for (const model of models) {
        if (!groups.has(model.provider)) groups.set(model.provider, []);
        groups.get(model.provider).push(model);
      }
      const rowButton = (body, label, type, cellTag) => {
        const row = html("tr");
        const cell = html(cellTag);
        const button = html("button");
        button.type = "button";
        button.className = `aip-pref-magpie-row aip-pref-magpie-${type}`;
        const text = html("span");
        text.className = "aip-pref-magpie-name";
        text.textContent = label;
        button.append(text);
        cell.append(button);
        row.append(cell);
        body.append(row);
        return button;
      };
      let index = 0;
      for (const [provider, entries] of groups) {
        const head = html("tbody");
        const body = html("tbody");
        body.id = `aip-pref-magpie-provider-${index++}`;
        const arrow = rowButton(head, provider, "provider", "th");
        arrow.title = provider;
        arrow.setAttribute("aria-controls", body.id);
        const setExpanded = expanded => {
          body.hidden = !expanded;
          arrow.setAttribute("aria-expanded", String(expanded));
        };
        setExpanded(this.expandedProviders.has(provider));
        arrow.addEventListener("click", () => {
          const expanded = body.hidden;
          if (expanded) this.expandedProviders.add(provider);
          else this.expandedProviders.delete(provider);
          setExpanded(expanded);
        });
        for (const { id, name } of entries) {
          const button = rowButton(body, name, "model", "td");
          button.title = id;
          button.addEventListener("click", () => {
            this.runtime.toggleMagpieModel(id).catch(error => this.status("api", error.message, true));
          });
          this.magpieButtons.set(id, button);
        }
        fragment.append(head, body);
      }
      table.replaceChildren(fragment);
      table.hidden = models.length === 0;
    }
    const chosen = new Set(selected);
    for (const [id, button] of this.magpieButtons) button.setAttribute("aria-pressed", String(chosen.has(id)));
  },

  syncModels(api) {
    if (this.destroyed || this.modelDirty || this.modelTask) return;
    let sameSource = false;
    try { sameSource = this.runtime.core.modelsEndpoint(this.element("baseURL").value) === this.runtime.core.modelsEndpoint(api.baseURL); }
    catch (_) {}
    if (!sameSource || this.element("apiKey").value.trim() !== this.runtime.getAPIKey()) return;
    this.models = api.models;
    this.modelsSource = this.runtime.core.modelsEndpoint(api.baseURL);
    this.renderModels(api.model);
  },

  fitField(field) {
    const isKey = field.id === "aip-pref-apiKey";
    let text = field.localName === "select" ? field.selectedOptions[0]?.label || "" : field.value || field.placeholder;
    if (isKey && field.type === "password" && field.value) text = "•".repeat(field.value.length);
    if (!isKey && field.type !== "url") field.title = text;
    const canvas = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    const context = canvas.getContext("2d");
    const measure = (element, value) => {
      const style = this.doc.defaultView.getComputedStyle(element);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return Math.ceil(context.measureText(value).width + 1);
    };
    field.style.setProperty("--aip-field-text-width", `${measure(field, text)}px`);

    const row = field.parentElement;
    if (!row.dataset.fieldPair) return;
    const label = field.labels[0];
    row.style.setProperty("--aip-field-label-width", `${measure(label, label.textContent)}px`);
    const rows = [...row.parentElement.querySelectorAll(`[data-field-pair="${row.dataset.fieldPair}"]`)];
    const labelWidth = Math.max(...rows.map(member => parseFloat(member.style.getPropertyValue("--aip-field-label-width")) || 0));
    const textWidth = Math.max(...rows.map(member => parseFloat(member.lastElementChild.style.getPropertyValue("--aip-field-text-width")) || 0));
    for (const member of rows) {
      member.style.setProperty("--aip-pair-label-width", `${labelWidth}px`);
      member.style.setProperty("--aip-pair-text-width", `${textWidth}px`);
    }
  },

  renderModels(selected) {
    const select = this.element("model");
    const placeholder = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
    placeholder.value = "";
    placeholder.textContent = this.models.length ? "选择模型" : "尚未获取模型";
    placeholder.disabled = true;
    select.replaceChildren(placeholder, ...this.models.map(id => {
      const option = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = id;
      option.textContent = id;
      return option;
    }));
    select.value = this.models.includes(selected) ? selected : "";
    select.disabled = !this.models.length;
    this.fitField(select);
    this.element("testAPI").disabled = !select.value;
  },

  loadReading() {
    const reading = this.runtime.getSettings().reading;
    const select = this.element("readingMode");
    const historyLimit = this.element("historyChars");
    select.value = reading.mode;
    historyLimit.value = reading.historyChars;
    this.element("keepNativeSidebar").checked = reading.keepNativeSidebar;
    this.fitField(select);
    this.fitField(historyLimit);
  },

  renderSkillList(selectedID) {
    const settings = this.runtime.getSettings();
    const skills = new Map(settings.skills.map(skill => [skill.id, skill]));
    for (const [id, draft] of this.skillDrafts) skills.set(id, draft);
    const select = this.element("skill");
    select.replaceChildren(...Array.from(skills.values(), skill => {
      const option = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = skill.id;
      option.textContent = skill.name + (skill.id === settings.activeSkillID ? "（默认）" : "");
      return option;
    }));
    select.value = selectedID && skills.has(selectedID) ? selectedID : settings.activeSkillID;
    this.fitField(select);
  },

  readSkill() {
    return {
      id: this.skillID,
      name: this.element("skillName").value,
      prompt: this.element("skillPrompt").value
    };
  },

  rememberDraft() {
    if (!this.skillID) return;
    this.skillDrafts.set(this.skillID, { ...this.readSkill(), makeDefault: this.element("makeDefault").checked });
  },

  loadSkill(id) {
    const settings = this.runtime.getSettings();
    const skill = this.skillDrafts.get(id) || settings.skills.find(entry => entry.id === id);
    if (!skill) return;
    this.skillID = skill.id;
    const name = this.element("skillName");
    name.value = skill.name;
    this.fitField(name);
    this.element("skillPrompt").value = skill.prompt;
    this.element("makeDefault").checked = skill.makeDefault ?? settings.activeSkillID === id;
  }
};
