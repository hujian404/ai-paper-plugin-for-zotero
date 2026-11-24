"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const core = require("../addon/content/core.js");

const source = readFileSync(join(__dirname, "../addon/content/runtime.js"), "utf8");
const skill = { id: "reader", name: "Reader", prompt: "Read the paper." };
const defaultID = core.legacyAPIProfileID;
const secondID = "67da6035-8f7e-4cf7-99d8-f3cf7b2cd0eb";

function fixture() {
  const initial = core.defaults(skill);
  delete initial.apiProfiles;
  delete initial.activeAPIProfileID;
  initial.api = { baseURL: "http://localhost:8070/v1", model: "first" };
  let saved = JSON.stringify(initial);
  let exported;
  let failWrite = false;
  const entries = new Map([["AI论文插件", { realm: "AI论文插件", password: "legacy-test-key" }]]);
  const logins = {
    findLogins(_origin, _action, realm) { return entries.has(realm) ? [entries.get(realm)] : []; },
    addLoginAsync: async login => entries.set(login.realm, login),
    modifyLogin: (_old, login) => entries.set(login.realm, login),
    removeLogin: login => entries.delete(login.realm)
  };
  const Runtime = runInNewContext(source + "\nAIPaperRuntime", {
    URL,
    Services: { logins, uuid: { generateUUID: () => "{" + secondID + "}" } },
    Zotero: {
      Prefs: {
        get: () => saved,
        set: (_, value) => {
          if (failWrite) throw new Error("write failed");
          saved = value;
        }
      }
    },
    Cc: {
      "@mozilla.org/login-manager/loginInfo;1": {
        createInstance: () => ({
          init(_origin, _action, realm, _user, password) { Object.assign(this, { realm, password }); }
        })
      }
    },
    Ci: {},
    IOUtils: { writeUTF8: async (_, value) => { exported = value; } }
  });
  const runtime = Object.assign(Object.create(Runtime.prototype), {
    core, alive: true, settingsQueue: Promise.resolve(), listeners: new Set(),
    pickFile: async () => "settings.json"
  });
  return { runtime, saved: () => saved, exported: () => exported, breakWrites: () => { failWrite = true; } };
}

test("legacy credentials and separate keys at the same address survive switching and export", async () => {
  const { runtime, saved, exported } = fixture();
  assert.equal(runtime.getSettings().activeAPIProfileID, defaultID);
  assert.equal(runtime.getAPIKey(defaultID), "legacy-test-key");
  await runtime.createAPIProfile();
  assert.equal(runtime.getSettings().activeAPIProfileID, secondID);
  assert.equal(runtime.getAPIKey(secondID), "");
  await runtime.saveAPI(secondID, "Alternate account", { baseURL: "http://localhost:8070/v1", model: "second" }, "second-test-key");
  const picker = runtime.modelPicker();
  assert.equal(picker.profileID, secondID);
  assert.equal(picker.model, "second");
  assert.equal(runtime.getAPIKey(secondID), "second-test-key");
  await runtime.selectAPIProfile(defaultID);
  assert.equal(runtime.modelPicker().model, "first");
  assert.equal(runtime.getAPIKey(defaultID), "legacy-test-key");
  await assert.rejects(runtime.saveAPI(secondID, "Stale", { model: "stale" }, "stale-key"), /已切换/);
  await assert.rejects(runtime.selectModel("second", "direct", secondID), /已切换/);
  await runtime.exportConfig(null);
  const backup = JSON.parse(exported());
  assert.equal(backup.apiProfiles.length, 2);
  assert.equal(backup.activeAPIProfileID, defaultID);
  for (const data of [saved(), exported()]) assert.doesNotMatch(data, /(?:legacy|second)-test-key/);

  await runtime.selectAPIProfile(secondID);
  await runtime.deleteAPIProfile(secondID);
  assert.equal(runtime.getSettings().activeAPIProfileID, defaultID);
  assert.equal(runtime.getAPIKey(secondID), "");
  assert.equal(runtime.getAPIKey(defaultID), "legacy-test-key");
});

test("failed settings save restores only the changed credential", async () => {
  const { runtime, breakWrites } = fixture();
  await runtime.createAPIProfile();
  await runtime.saveAPI(secondID, "Alternate", { model: "second" }, "second-test-key");
  breakWrites();
  await assert.rejects(runtime.saveAPI(secondID, "New name", { model: "new" }, "replacement"), /write failed/);
  assert.equal(runtime.getAPIKey(secondID), "second-test-key");
  assert.equal(runtime.getAPIKey(defaultID), "legacy-test-key");
  assert.equal(runtime.modelPicker().model, "second");
});

test("import merges named profiles and legacy configurations apply only to the active profile", () => {
  const first = core.defaults(skill);
  const alternate = { id: secondID, name: "Alternate", api: { model: "second", apiKey: "ignored-test-key" } };
  const imported = core.parseImport(JSON.stringify({ apiProfiles: [alternate], activeAPIProfileID: secondID }));
  const merged = core.mergeImport(first, imported);
  assert.equal(merged.apiProfiles.length, 2);
  assert.equal(core.activeAPIProfile(merged).api.model, "second");
  assert.doesNotMatch(JSON.stringify(merged), /ignored-test-key/);

  const legacy = core.parseImport('{"model":"updated","baseURL":"https://example.test/v1","apiKey":"test-only"}');
  const next = core.mergeImport(merged, legacy);
  assert.equal(core.activeAPIProfile(next).api.model, "updated");
  assert.equal(next.apiProfiles.find(({ id }) => id === defaultID).api.model, "");
  assert.throws(() => core.normalizeAPIProfiles([alternate, alternate]), /重复/);
});
