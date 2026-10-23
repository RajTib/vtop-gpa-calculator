const test = require("node:test");
const assert = require("node:assert/strict");

const storage = require("../js/storage");
const model = require("../js/model");
const gpa = require("../js/gpa");

// Minimal localStorage stand-in with failure injection.
class FakeStorage {
    constructor(opts = {}) { this.map = new Map(); this.opts = opts; this.writes = 0; }
    get length() { return this.map.size; }
    key(i) { return Array.from(this.map.keys())[i] ?? null; }
    getItem(k) {
        if (this.opts.throwOnGet) throw new Error("SecurityError");
        return this.map.has(k) ? this.map.get(k) : null;
    }
    setItem(k, v) {
        if (this.opts.failWhen && this.opts.failWhen(k)) {
            const e = new Error("quota"); e.name = "QuotaExceededError"; e.code = 22; throw e;
        }
        this.writes++;
        this.map.set(k, String(v));
    }
    removeItem(k) { this.map.delete(k); }
}

function sampleState() {
    let s = model.createSemester(model.emptyState(), 1, { status: "completed" }).state;
    s = model.addCourses(s, 1, [{ code: "A1", name: "Alpha", credits: 4 }, { code: "A2", name: "Beta", credits: 3 }]).state;
    s = model.createSemester(s, 2, { status: "ongoing" }).state;
    s = model.addCourses(s, 2, [{ code: "B1", name: "Gamma", credits: 3 }]).state;
    return s;
}

const storeFor = (backing, now) => storage.createStore(() => backing, now);

test("fresh browser: load reports empty and writes nothing", () => {
    const backing = new FakeStorage();
    const r = storeFor(backing).load();
    assert.equal(r.status, "empty");
    assert.deepEqual(r.state, model.emptyState());
    assert.equal(backing.writes, 0);
});

test("data survives a reload (new store instance over the same storage)", () => {
    const backing = new FakeStorage();
    const state = sampleState();
    assert.equal(storeFor(backing).save(state).ok, true);

    const reloaded = storeFor(backing).load();      // simulates a page refresh
    assert.equal(reloaded.status, "ok");
    assert.deepEqual(reloaded.state, state);
    assert.equal(gpa.computeCgpa(reloaded.state.semesters).display, gpa.computeCgpa(state.semesters).display);
});

test("only the validated state is stored: no raw timetable text, no extra keys", () => {
    const backing = new FakeStorage();
    storeFor(backing).save(sampleState());
    assert.deepEqual(Array.from(backing.map.keys()), [storage.KEY]);
    const stored = JSON.parse(backing.getItem(storage.KEY));
    assert.deepEqual(Object.keys(stored).sort(), ["currentSemester", "schemaVersion", "semesters"]);
});

test("malformed JSON: app starts empty, original is untouched, a copy is quarantined", () => {
    const backing = new FakeStorage();
    backing.map.set(storage.KEY, '{"schemaVersion":1,"semesters":[{');
    const before = backing.getItem(storage.KEY);
    const r = storeFor(backing, () => 111).load();

    assert.equal(r.status, "corrupt");
    assert.deepEqual(r.state, model.emptyState());
    assert.equal(r.backupKey, storage.CORRUPT_PREFIX + "111");
    assert.equal(backing.getItem(storage.KEY), before, "original must not be modified by load()");
    assert.equal(backing.getItem(r.backupKey), before);
});

test("structurally invalid data and future schema versions are preserved, not discarded", () => {
    const cases = [
        JSON.stringify({ schemaVersion: 1, semesters: [{ number: 99, status: "completed" }] }),
        JSON.stringify({ schemaVersion: 7, semesters: [] }),
        JSON.stringify([1, 2, 3]),
        "null",
    ];
    for (const raw of cases) {
        const backing = new FakeStorage();
        backing.map.set(storage.KEY, raw);
        const r = storeFor(backing, () => 5).load();
        assert.equal(r.status, "corrupt", raw);
        assert.equal(backing.getItem(storage.KEY), raw);
        assert.equal(backing.getItem(storage.CORRUPT_PREFIX + "5"), raw);
        assert.ok(r.message.length > 0);
    }
});

test("after quarantine the user can keep working and the quarantined copy survives later saves", () => {
    const backing = new FakeStorage();
    backing.map.set(storage.KEY, "not json");
    const store = storeFor(backing, () => 9);
    const r = store.load();
    assert.equal(store.save(sampleState()).ok, true);
    assert.equal(backing.getItem(r.backupKey), "not json");
    assert.equal(storeFor(backing).load().status, "ok");
});

test("if unreadable data cannot be copied, saving is blocked so it can't be overwritten", () => {
    const backing = new FakeStorage({ failWhen: k => k.startsWith(storage.CORRUPT_PREFIX) });
    backing.map.set(storage.KEY, "garbage");
    const store = storeFor(backing);
    const r = store.load();
    assert.equal(r.status, "corrupt");
    assert.equal(r.blocked, true);
    assert.equal(r.backupKey, null);

    const res = store.save(sampleState());
    assert.deepEqual(res, { ok: false, reason: "blocked" });
    assert.equal(backing.getItem(storage.KEY), "garbage");
    assert.equal(store.readRaw(), "garbage");      // can be offered as a download
});

test("storage unavailable (access throws): app works in memory, nothing throws", () => {
    const store = storage.createStore(() => { throw new Error("SecurityError"); });
    assert.equal(store.load().status, "unavailable");
    assert.deepEqual(store.save(sampleState()), { ok: false, reason: "unavailable" });
    assert.equal(store.isMemoryOnly(), true);
    assert.equal(store.readRaw(), null);
    assert.equal(store.clearAll().ok, false);

    const store2 = storeFor(new FakeStorage({ throwOnGet: true }));
    assert.equal(store2.load().status, "unavailable");

    const store3 = storage.createStore(() => null);
    assert.equal(store3.load().status, "unavailable");
});

test("quota errors are reported, previous data stays intact", () => {
    const backing = new FakeStorage();
    const store = storeFor(backing);
    const good = sampleState();
    assert.equal(store.save(good).ok, true);
    const saved = backing.getItem(storage.KEY);

    backing.opts.failWhen = () => true;
    assert.deepEqual(store.save(model.emptyState()), { ok: false, reason: "quota" });
    assert.equal(backing.getItem(storage.KEY), saved);
});

test("clearAll removes only this app's keys, including backups", () => {
    const backing = new FakeStorage();
    backing.map.set("somethingElse", "keep me");
    backing.map.set(storage.KEY, "x");
    backing.map.set(storage.PREV_KEY, "y");
    backing.map.set(storage.CORRUPT_PREFIX + "1", "z");
    const res = storeFor(backing).clearAll();
    assert.deepEqual(res, { ok: true, removed: 3 });
    assert.deepEqual(Array.from(backing.map.keys()), ["somethingElse"]);
    assert.equal(storeFor(backing).load().status, "empty");
});

test("clearAll unblocks a store whose unreadable data could not be preserved", () => {
    const backing = new FakeStorage({ failWhen: k => k.startsWith(storage.CORRUPT_PREFIX) });
    backing.map.set(storage.KEY, "garbage");
    const store = storeFor(backing);
    store.load();
    assert.equal(store.isBlocked(), true);
    store.clearAll();
    assert.equal(store.isBlocked(), false);
    assert.equal(store.save(sampleState()).ok, true);
});

// ---- export / import -----------------------------------------------------------------------

test("export then import round-trips exactly", () => {
    const state = sampleState();
    const text = storage.buildExport(state, "2026-01-01T00:00:00.000Z");
    const parsed = JSON.parse(text);
    assert.equal(parsed.app, storage.EXPORT_APP);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.exportedAt, "2026-01-01T00:00:00.000Z");

    const res = storage.parseImport(text);
    assert.equal(res.ok, true);
    assert.deepEqual(res.state, state);
});

test("import rejects bad files with a reason and never throws", () => {
    const good = JSON.parse(storage.buildExport(sampleState()));
    const bad = [
        [undefined, /No file content/],
        ["", /not valid JSON/],
        ["{not json", /not valid JSON/],
        ["[]", /not a backup file/],
        ["null", /not a backup file/],
        [JSON.stringify({ app: "other", schemaVersion: 1, data: good.data }), /not a backup file/],
        [JSON.stringify({ app: good.app, schemaVersion: 99, data: good.data }), /unsupported version/],
        [JSON.stringify({ app: good.app, schemaVersion: 1, data: { schemaVersion: 1, semesters: "x" } }), /list/],
        ["x".repeat(1000001), /too large/],
    ];
    for (const [text, re] of bad) {
        const res = storage.parseImport(text);
        assert.equal(res.ok, false, String(text).slice(0, 30));
        assert.match(res.errors[0], re);
    }
});

test("import rejects records with missing required fields (incomplete records)", () => {
    const good = JSON.parse(storage.buildExport(sampleState()));
    good.data.semesters[0].courses[0].name = "";
    assert.equal(storage.parseImport(JSON.stringify(good)).ok, false);
    good.data.semesters[0].courses[0].name = "Alpha";
    delete good.data.semesters[0].status;
    assert.equal(storage.parseImport(JSON.stringify(good)).ok, false);
});

test("import is inert: scripts and unknown fields in a backup are dropped, text stays text", () => {
    const good = JSON.parse(storage.buildExport(sampleState()));
    good.data.semesters[0].courses[0].name = "<script>alert(1)</script>";
    good.data.semesters[0].courses[0].exec = "alert(1)";
    good.data.hook = "javascript:alert(1)";
    const res = storage.parseImport(JSON.stringify(good));
    assert.equal(res.ok, true);
    assert.equal(res.state.semesters[0].courses[0].name, "<script>alert(1)</script>");   // data only; UI uses textContent
    assert.equal(res.state.semesters[0].courses[0].exec, undefined);
    assert.equal(res.state.hook, undefined);
});

test("a failed import leaves existing records untouched (parseImport is pure)", () => {
    const backing = new FakeStorage();
    const store = storeFor(backing);
    store.save(sampleState());
    const before = backing.getItem(storage.KEY);
    const writes = backing.writes;

    const res = storage.parseImport("{broken");
    assert.equal(res.ok, false);
    assert.equal(backing.getItem(storage.KEY), before);
    assert.equal(backing.writes, writes);
});

test("importing replaces data but first keeps the previous profile under a .prev key", () => {
    const backing = new FakeStorage();
    const store = storeFor(backing);
    store.save(sampleState());
    const before = backing.getItem(storage.KEY);

    const incoming = model.createSemester(model.emptyState(), 5, { status: "completed" }).state;
    assert.equal(store.replaceWith(incoming).ok, true);
    assert.equal(backing.getItem(storage.PREV_KEY), before);
    assert.deepEqual(storeFor(backing).load().state, incoming);
});

test("if the safety copy cannot be made, import does not replace anything", () => {
    const backing = new FakeStorage({ failWhen: k => k === storage.PREV_KEY });
    const store = storeFor(backing);
    store.save(sampleState());
    const before = backing.getItem(storage.KEY);

    const res = store.replaceWith(model.emptyState());
    assert.deepEqual(res, { ok: false, reason: "backup-failed" });
    assert.equal(backing.getItem(storage.KEY), before);
});

test("importing the same backup twice is idempotent (no duplicated courses)", () => {
    const backing = new FakeStorage();
    const store = storeFor(backing);
    const text = storage.buildExport(sampleState());
    store.replaceWith(storage.parseImport(text).state);
    store.replaceWith(storage.parseImport(text).state);
    const loaded = storeFor(backing).load().state;
    assert.equal(loaded.semesters[0].courses.length, 2);
    assert.equal(loaded.semesters.length, 2);
});
