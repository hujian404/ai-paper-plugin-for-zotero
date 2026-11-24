const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const core = require("../addon/content/core.js");
const defaultSkill = core.parseSkillText(readFileSync(join(__dirname, "../addon/content/paper-reader.md"), "utf8"),
  "paper-reader.md", "paper-reader");

test("shortcuts use Ctrl on Windows and Linux and Command on macOS", () => {
  for (const isMac of [false, true]) {
    const primary = { ctrlKey: !isMac, metaKey: isMac };
    assert.equal(core.hasPrimaryModifier(primary, isMac), true);
    assert.equal(core.hasPrimaryModifier(primary, !isMac), false);
    assert.equal(core.hasPrimaryModifier({ ctrlKey: false, metaKey: false }, isMac), false);
    assert.equal(core.hasPrimaryModifier({ ctrlKey: true, metaKey: true }, isMac), false);
    assert.equal(core.hasPrimaryModifier({ ...primary, altKey: true }, isMac), false);
    assert.equal(core.hasPrimaryModifier({ ...primary, shiftKey: true }, isMac), false);
  }
});

test("base URLs, full endpoints and query strings resolve consistently", () => {
  const examples = [
    ["https://api.example.com", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/v1/", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/chat/completions/", "https://api.example.com/chat/completions"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1/chat/completions"],
    ["https://api.example.com/compatible-mode/v1?region=cn", "https://api.example.com/compatible-mode/v1/chat/completions?region=cn"]
  ];
  for (const [input, expected] of examples) assert.equal(core.endpoint(input), expected);
});

test("invalid URLs and unsupported endpoint formats are rejected", () => {
  for (const value of ["bad", "file:///etc/passwd", "https://key@host/v1", "https://host/v1/responses"]) {
    assert.throws(() => core.endpoint(value));
  }
});

test("model discovery resolves the same API prefix and query as chat", () => {
  const examples = [
    ["https://api.example.com", "https://api.example.com/v1/models"],
    ["https://api.example.com/v1/", "https://api.example.com/v1/models"],
    ["https://api.example.com/chat/completions/", "https://api.example.com/models"],
    ["https://api.example.com/compatible-mode/v1/chat/completions?region=cn", "https://api.example.com/compatible-mode/v1/models?region=cn"]
  ];
  for (const [input, expected] of examples) assert.equal(core.modelsEndpoint(input), expected);
});

test("Magpie groups chat models by provider and keeps inventory separate from selected routes", () => {
  const models = core.readMagpieModels({ data: [
    { id: "alpha/team/shared", display_name: "Shared", owned_by: "alpha" },
    { id: "beta/shared", display_name: "Shared", owned_by: "beta" },
    { id: "alpha/team/shared" },
    { id: "alpha/text-v2" },
    { id: "auto/shared" }, { id: "group/route" }, { id: "beta/picture", kind: "image" }, { display_name: "Invalid" }
  ] });
  assert.deepEqual(models, [
    { id: "alpha/team/shared", name: "Shared", provider: "alpha" },
    { id: "beta/shared", name: "Shared", provider: "beta" },
    { id: "alpha/text-v2", name: "text-v2", provider: "alpha" }
  ]);
  assert.deepEqual(core.validateMagpie({ models }).selected, []);
  assert.deepEqual(core.readMagpieModels({ data: [] }), []);
  assert.throws(() => core.readMagpieModels({ models }), /模型目录/);

  const before = core.validateMagpie({ models, port: 3537, selected: ["alpha/team/shared", "beta/shared"], model: "alpha/team/shared" });
  const refreshed = core.validateMagpie({ ...before, models: models.slice(1) });
  assert.equal(refreshed.port, 3537);
  assert.deepEqual(refreshed.selected, ["beta/shared"]);
  assert.equal(refreshed.model, "beta/shared");
  const imported = core.parseImport(JSON.stringify({ ...core.defaults(defaultSkill), apiMode: "magpie", magpie: refreshed }));
  const restored = core.mergeImport(core.defaults(defaultSkill), imported);
  assert.equal(restored.apiMode, "magpie");
  assert.deepEqual(restored.magpie, refreshed);
  assert.equal(core.activeAPIProfile(restored).api.baseURL, "https://api.openai.com/v1");
});

test("model lists retain exact IDs and deduplicate invalid and empty entries", () => {
  const ids = core.readModels({ data: [{ id: " model-one " }, { id: "provider/model-two" }, null,
    { id: "model-one" }, { id: 123 }, { id: "" }, { id: "x".repeat(201) }] });
  assert.deepEqual(ids, ["model-one", "provider/model-two"]);
  assert.throws(() => core.readModels({ data: [] }));
  assert.throws(() => core.readModels({ models: [] }));
});

test("legacy configured models migrate into the dropdown catalog", () => {
  const api = core.validateAPI({ baseURL: "https://host/v1", model: "existing-model" });
  assert.deepEqual(api.models, ["existing-model"]);
  assert.deepEqual(core.validateAPI({ model: "a", models: ["a", "b", "a"] }).models, ["a", "b"]);
  assert.throws(() => core.validateAPI({ model: "a", models: {} }));
});

test("provider-only imports allow fetching models after configuration", () => {
  const imported = core.parseImport('{"baseURL":"https://host/v1","apiKey":"secret"}');
  assert.equal(imported.api.model, "");
  assert.deepEqual(imported.api.models, []);
  assert.throws(() => core.validateAPI(imported.api));
});

test("fresh settings contain only the bundled Paper Reader and keep default objects independent", () => {
  const first = core.defaults(defaultSkill);
  assert.equal(first.activeSkillID, "paper-reader");
  assert.deepEqual(first.skills, [defaultSkill]);
  assert.equal(first.skills[0].name, "论文精读");
  core.activeAPIProfile(first).api.models.push("local-model");
  first.skills[0].prompt = "编辑过的提示词";
  const second = core.defaults(defaultSkill);
  assert.deepEqual(core.activeAPIProfile(second).api.models, []);
  assert.ok(second.skills[0].prompt.includes("作者信息与外链"));
});

test("API input validation preserves blank temperature and rejects invalid bounds", () => {
  const api = core.validateAPI({ model: "example" });
  assert.equal(api.temperature, "");
  assert.equal(api.timeoutSeconds, 180);
  for (const value of ["", "abc", -1, 1.2]) {
    assert.throws(() => core.validateAPI({ ...api, maxTokens: value }));
  }
  assert.throws(() => core.validateAPI({ model: "" }));
  assert.throws(() => core.validateAPI({ model: "example", contextChars: 0 }));
});

test("request payload handles standard and reasoning model token parameters", () => {
  for (const tokenParameter of ["max_tokens", "max_completion_tokens", "none"]) {
    const api = core.validateAPI({ model: "example", tokenParameter });
    const payload = core.requestBody(api, []);
    assert.equal(payload.stream, false);
    assert.equal("temperature" in payload, false);
    assert.equal("max_tokens" in payload, tokenParameter === "max_tokens");
    assert.equal("max_completion_tokens" in payload, tokenParameter === "max_completion_tokens");
  }
  const api = core.validateAPI({ model: "example" });
  assert.equal(core.requestBody(api, [], true).stream, true);
  assert.deepEqual(core.requestBody(api, [], true).stream_options, { include_usage: true });
  assert.equal("stream_options" in core.requestBody(api, [], true, false), false);
});

test("API import accepts base_url and preserves the existing key when omitted", () => {
  const imported = core.parseImport('\uFEFF{"base_url":"https://host/v1","model":"local"}');
  assert.equal(imported.api.baseURL, "https://host/v1");
  assert.equal("apiKey" in imported, false);
  const withKey = core.parseImport('{"api":{"baseURL":"https://host/v1","model":"x","api_key":" secret "}}');
  assert.equal(withKey.apiKey, "secret");
});

test("malformed configuration, duplicate skills and unknown schema versions fail before merge", () => {
  for (const text of ["{}", "{", '{"schemaVersion":2}',
    JSON.stringify({ skills: [{ id: "x", name: "a", prompt: "b" }, { id: "x", name: "c", prompt: "d" }] })]) {
    assert.throws(() => core.parseImport(text));
  }
});

test("skill imports merge by ID without removing unrelated skills", () => {
  const original = core.defaults(defaultSkill);
  const custom = { id: "custom-reading", name: "复现笔记", prompt: "记录实验条件。" };
  original.skills.push(custom);
  const imported = core.parseImport(JSON.stringify({ skills: [{ id: "paper-reader", name: "自定义", prompt: "提取主要结论" }] }));
  const next = core.mergeImport(original, imported);
  assert.deepEqual(next.skills, [imported.skills[0], custom]);
  assert.equal(original.skills[0].name, "论文精读");
  assert.throws(() => core.mergeImport(original, { activeSkillID: "missing" }));
});

test("freshly exported full settings can be imported before selecting a model", () => {
  const settings = core.defaults(defaultSkill);
  const imported = core.parseImport(JSON.stringify(settings));
  assert.deepEqual(core.mergeImport(settings, imported), settings);
});

test("SKILL.md front matter is imported as text without code execution", () => {
  const skill = core.parseSkillText('---\r\nname: "方法精读"\r\ndescription: example\r\n---\r\n# 内容\r\n读取方法。', "SKILL.md");
  assert.equal(skill.name, "方法精读");
  assert.equal(skill.prompt, "# 内容\r\n读取方法。");
  assert.throws(() => core.parseSkillText("  "));
});

test("text limits keep both ends, respect the character budget and preserve Unicode", () => {
  const original = "开头🧠".repeat(500) + "结尾";
  const result = core.limitText(original, 1000);
  assert.equal(result.truncated, true);
  assert.ok(Array.from(result.text).length <= 1000);
  assert.ok(result.text.startsWith("开头"));
  assert.ok(result.text.endsWith("结尾"));
  assert.equal(core.limitText("摘要", 1000).truncated, false);
});

test("response parsing handles content blocks, refusal and exhausted reasoning budget", () => {
  assert.deepEqual(core.readResponse({ choices: [{ message: { content: "  总结  " }, finish_reason: "stop" }] }),
    { text: "总结", truncated: false, usage: null });
  assert.equal(core.readResponse({ choices: [{ message: { content: [{ type: "text", text: "内容" }] }, finish_reason: "length" }] }).truncated, true);
  assert.throws(() => core.readResponse({ choices: [{ message: { refusal: "refused" } }] }));
  assert.throws(() => core.readResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
  const choice = { message: { content: "正文", reasoning_content: "模型过程" } };
  assert.equal(core.readResponse({ choices: [choice] }).reasoning, "模型过程");
});

test("usage metrics use the complete prompt as the cache denominator and preserve missing data", () => {
  assert.deepEqual(core.usageMetrics({ prompt_tokens: 80, prompt_cache_hit_tokens: 24, completion_tokens: 20 }),
    { total: 100, cacheRate: 0.3 });
  assert.deepEqual(core.usageMetrics({ total_tokens: 75, prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } }),
    { total: 75, cacheRate: 0 });
  assert.deepEqual(core.usageMetrics({ prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70, completion_tokens: 10 }),
    { total: 110, cacheRate: 0.3 });
  assert.deepEqual(core.usageMetrics({ prompt_tokens: 80, prompt_cache_hit_tokens: 81 }), { total: null, cacheRate: null });
  assert.deepEqual(core.usageMetrics(null), { total: null, cacheRate: null });
});

test("streamed reasoning, answer and usage arrive incrementally across split SSE frames", () => {
  const events = [];
  const parser = core.completionStream(event => events.push(event));
  let body = ": heartbeat\r\n\r\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"查看";
  parser.read(body);
  assert.equal(events.length, 0);
  body += "实验\"}}]}\r\n\r\n";
  parser.read(body);
  assert.deepEqual(events[0], { text: "", reasoning: "查看实验", usage: null });
  body += 'data: {"choices":[{"delta":{"content":"# 总结"}}]}\n\n';
  parser.read(body);
  assert.equal(events.at(-1).text, "# 总结");
  const usage = { prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 10 }, total_tokens: 75 };
  body += 'data: {"choices":[{"finish_reason":"length"}]}\n\n';
  body += `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]`;
  parser.read(body, true);
  assert.deepEqual(parser.result(), { text: "# 总结", reasoning: "查看实验", truncated: true, usage });
  assert.equal(core.usageMetrics(events.at(-1).usage).cacheRate, 0.2);
});

test("partial or malformed streams cannot be committed as complete answers", () => {
  const parser = core.completionStream(() => {});
  const response = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  parser.read(response);
  assert.throws(() => parser.result(), /提前断开/);
  parser.read(response + "data: {malformed}\n\n", true);
  assert.throws(() => parser.result(), /无效的流式响应/);
  const failure = core.completionStream(() => {});
  failure.read(response + 'data: {"error":{"message":"service error"}}\n\n', true);
  assert.equal(failure.apiError.error.message, "service error");
});

test("rendered summaries escape executable markup before inline formatting", () => {
  const rendered = core.markdownHTML('# 标题\n**重点**\n- <img src=x onerror="alert(1)">\n```\n<script>bad()</script>\n```');
  assert.ok(rendered.includes("<h1>标题</h1>"));
  assert.ok(rendered.includes("<strong>重点</strong>"));
  assert.ok(!rendered.includes("<img"));
  assert.ok(!rendered.includes("<script>"));
  assert.ok(rendered.includes("&lt;script&gt;"));
});

test("chat requests retain recent completed turns and the current question", () => {
  const paper = { text: "论文正文", source: "PDF 全文", metadata: "论文A" };
  const skill = { prompt: "解释研究依据。" };
  const turns = [
    { state: "complete", question: "旧问题".repeat(50), answer: "旧回答".repeat(50) },
    { state: "error", question: "失败请求", answer: null },
    { state: "complete", question: "近期问题", answer: "近期回答" }
  ];
  const messages = core.chatMessages(paper, skill, turns, "继续提问", 20);
  assert.equal(messages.length, 5);
  assert.equal(messages[2].content, "近期问题");
  assert.equal(messages[3].role, "assistant");
  assert.equal(messages[4].content, "继续提问");
  assert.ok(!messages.some(message => message.content === "失败请求"));
});

test("reading configuration supports old settings and validates imported values", () => {
  assert.deepEqual(core.validateReading(), { mode: "auto", historyChars: 20000, keepNativeSidebar: false });
  assert.throws(() => core.validateReading({ mode: "invalid" }));
  assert.throws(() => core.validateReading({ historyChars: 0 }));
  const imported = core.parseImport('{"reading":{"mode":"abstract","historyChars":12000}}');
  assert.equal(core.mergeImport(core.defaults(defaultSkill), imported).reading.mode, "abstract");
  const defaults = core.defaults(defaultSkill);
  const enabled = core.parseImport('{"reading":{"keepNativeSidebar":true}}');
  const settings = core.mergeImport(defaults, enabled);
  assert.equal(settings.reading.keepNativeSidebar, true);
  assert.equal(core.mergeImport(settings, imported).reading.keepNativeSidebar, true);
  const disabled = core.parseImport('{"reading":{"keepNativeSidebar":false}}');
  assert.equal(core.mergeImport(settings, disabled).reading.keepNativeSidebar, false);
});

test("supplemental files share the configured character budget and strip local paths", () => {
  const files = core.prepareFiles([{ name: "a.txt", path: "/private/file", text: "a".repeat(600) },
    { name: "b.txt", text: "b".repeat(600) }], 1000);
  assert.ok(files.every(file => file.text.length <= 500 && file.truncated));
  assert.equal("path" in files[0], false);
  assert.throws(() => core.prepareFiles([{ name: "a.txt", text: "" }], 1000));
  assert.equal(core.limitText("abcdef", 1).text, "a");
});

test("chat includes current and prior file text within the history budget", () => {
  const paper = { text: "论文", source: "PDF", metadata: "A" };
  const turns = [{ state: "complete", question: "比较", answer: "回答", files: [{ name: "old.txt", text: "旧数据" }] }];
  const messages = core.chatMessages(paper, { prompt: "分析" }, turns, "继续", 1000, [{ name: "new.csv", text: "新数据" }]);
  assert.ok(messages[2].content.includes("旧数据"));
  assert.ok(messages.at(-1).content.includes("new.csv"));
  assert.ok(messages.at(-1).content.includes("新数据"));
  assert.equal(core.chatMessages(paper, { prompt: "分析" }, turns, "继续", 10).length, 3);
});

test("multimodal requests prioritize new images and keep recent ancestor images within the limit", () => {
  const picture = name => ({ name, dataURL: "data:image/png;base64,iVBORw0KGgo=" });
  const current = [picture("新图片 1"), picture("新图片 2")];
  const turns = [
    { state: "complete", question: "旧问题", answer: "旧回答", images: [picture("旧图")] },
    { state: "complete", question: "上个问题", answer: "上个回答", images: [picture("近图 1"), picture("近图 2"), picture("近图 3")] }
  ];
  const paper = { source: "PDF", metadata: "", text: "资料" };
  const skill = { prompt: "解释论文" };
  const messages = core.chatMessages(paper, skill, turns, "关于新图的问题", 10000, [], core.prepareImages(current));
  assert.equal(messages[2].content, "旧问题");
  assert.equal(messages[4].content.length, 3);
  assert.match(messages[4].content[0].text, /近图 1、近图 2$/);
  assert.deepEqual(messages.at(-1).content[2], { type: "image_url", image_url: { url: current[1].dataURL } });
  assert.equal(core.chatMessages(paper, skill, turns, "只发送当前图片", 0, [], current).length, 3);
});

test("image attachments accept bounded local PNG and JPEG data", () => {
  const dataURL = "data:image/jpeg;base64,/9j/AA==";
  assert.deepEqual(core.prepareImages([{ name: "图", dataURL, path: "/private/test.jpg" }]), [{ name: "图", dataURL }]);
  assert.throws(() => core.prepareImages([{ name: "外链", dataURL: "https://example.com/image.png" }]), /图片/);
  assert.throws(() => core.prepareImages([{ name: "文本", dataURL: "data:text/html;base64,AA==" }]), /图片/);
  assert.throws(() => core.prepareImages([{ name: "大图", dataURL: "data:image/png;base64," + "A".repeat(1_400_000) }]), /大小/);
  assert.throws(() => core.prepareImages(Array(5).fill({ name: "图", dataURL })), /最多/);
});
