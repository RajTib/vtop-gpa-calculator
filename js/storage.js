/*
 * Local persistence (localStorage) plus JSON backup export/import.
 * No DOM. The storage object is injected, so tests can simulate quota errors, corrupt
 * data and disabled storage.
 *
 * Safety rules:
 *   - load() never writes anything unless it has to quarantine unreadable data, and it
 *     quarantines by COPYING; the original key is left alone until the user saves again.
 *   - If unreadable data cannot be copied (quota), saving is blocked so it can't be lost.
 *   - Only the validated, whitelisted state is ever stored. The raw pasted timetable
 *     text is never stored.
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports;
    var deps = isNode ? { model: require("./model") } : (root.VtopGpa || {});
    var api = factory(deps);
    if (isNode) {
        module.exports = api;
    } else {
        root.VtopGpa = root.VtopGpa || {};
        root.VtopGpa.storage = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (deps) {
    var model = deps.model;

    var KEY = "vtopGpa.v1";
    var PREV_KEY = KEY + ".prev";
    var CORRUPT_PREFIX = KEY + ".corrupt.";
    var KEY_NAMESPACE = "vtopGpa.";
    var EXPORT_APP = "vtop-gpa-calculator";
    var MAX_IMPORT_CHARS = 1000000;

    function isQuotaError(e) {
        return !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
                       e.code === 22 || e.code === 1014);
    }

    function createStore(getStorage, now) {
        now = now || function () { return Date.now(); };
        var blocked = false;      // unreadable data could not be preserved -> do not overwrite it
        var memoryOnly = false;   // storage is unavailable -> nothing can be persisted

        function open() {
            try { return getStorage() || null; } catch (e) { return null; }
        }

        function quarantine(raw, message) {
            var s = open();
            var backupKey = CORRUPT_PREFIX + now();
            var kept = false;
            try { s.setItem(backupKey, raw); kept = true; } catch (e) { kept = false; }
            if (!kept) blocked = true;
            return {
                status: "corrupt",
                state: model.emptyState(),
                message: message,
                backupKey: kept ? backupKey : null,
                blocked: !kept
            };
        }

        function load() {
            var s = open();
            if (!s) { memoryOnly = true; return { status: "unavailable", state: model.emptyState() }; }

            var raw;
            try { raw = s.getItem(KEY); } catch (e) {
                memoryOnly = true;
                return { status: "unavailable", state: model.emptyState() };
            }
            if (raw === null || raw === undefined) return { status: "empty", state: model.emptyState() };

            var parsed;
            try { parsed = JSON.parse(raw); } catch (e) {
                return quarantine(raw, "Your saved data could not be read (it is not valid JSON).");
            }
            var v = model.validateState(parsed);
            if (!v.ok) {
                return quarantine(raw, v.unsupportedVersion
                    ? "Your saved data was written by a different version of this app and was not changed."
                    : "Your saved data failed validation (" + v.errors[0] + ").");
            }
            return { status: "ok", state: v.state };
        }

        function save(state) {
            if (memoryOnly) return { ok: false, reason: "unavailable" };
            if (blocked) return { ok: false, reason: "blocked" };
            var s = open();
            if (!s) { memoryOnly = true; return { ok: false, reason: "unavailable" }; }
            try {
                s.setItem(KEY, JSON.stringify(state));
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: isQuotaError(e) ? "quota" : "unavailable" };
            }
        }

        // Raw text currently stored under the main key (used to download unreadable data).
        function readRaw() {
            var s = open();
            if (!s) return null;
            try { return s.getItem(KEY); } catch (e) { return null; }
        }

        // Replace the stored profile with an imported one. The previous raw value is first copied to
        // a ".prev" key; if that copy fails, nothing is replaced.
        function replaceWith(state) {
            var s = open();
            if (!s) return { ok: false, reason: "unavailable" };
            var existing = readRaw();
            if (existing !== null) {
                try { s.setItem(PREV_KEY, existing); } catch (e) {
                    return { ok: false, reason: "backup-failed" };
                }
            }
            blocked = false;
            memoryOnly = false;
            return save(state);
        }

        // Explicit "clear all data": removes every key this app owns, including backups.
        function clearAll() {
            var s = open();
            if (!s) return { ok: false, reason: "unavailable" };
            try {
                var keys = [];
                for (var i = 0; i < s.length; i++) {
                    var k = s.key(i);
                    if (typeof k === "string" && k.indexOf(KEY_NAMESPACE) === 0) keys.push(k);
                }
                keys.forEach(function (k) { s.removeItem(k); });
                blocked = false;
                return { ok: true, removed: keys.length };
            } catch (e) {
                return { ok: false, reason: "unavailable" };
            }
        }

        return {
            load: load, save: save, readRaw: readRaw, replaceWith: replaceWith, clearAll: clearAll,
            isBlocked: function () { return blocked; },
            isMemoryOnly: function () { return memoryOnly; }
        };
    }

    // ---- backup file ----------------------------------------------------------------------

    function buildExport(state, exportedAt) {
        return JSON.stringify({
            app: EXPORT_APP,
            schemaVersion: model.SCHEMA_VERSION,
            exportedAt: exportedAt || new Date().toISOString(),
            data: state
        }, null, 2);
    }

    // Returns { ok: true, state } or { ok: false, errors: [...] }. Never throws, never mutates anything.
    function parseImport(text) {
        if (typeof text !== "string") return { ok: false, errors: ["No file content."] };
        if (text.length > MAX_IMPORT_CHARS) return { ok: false, errors: ["File is too large to be a backup from this app."] };
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) {
            return { ok: false, errors: ["This file is not valid JSON."] };
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.app !== EXPORT_APP) {
            return { ok: false, errors: ["This is not a backup file from the VTOP GPA Calculator."] };
        }
        if (parsed.schemaVersion !== model.SCHEMA_VERSION) {
            return { ok: false, errors: ["This backup uses an unsupported version (" + JSON.stringify(parsed.schemaVersion) + ")."] };
        }
        var v = model.validateState(parsed.data);
        if (!v.ok) return { ok: false, errors: v.errors };
        return { ok: true, state: v.state };
    }

    return {
        KEY: KEY,
        PREV_KEY: PREV_KEY,
        CORRUPT_PREFIX: CORRUPT_PREFIX,
        EXPORT_APP: EXPORT_APP,
        createStore: createStore,
        buildExport: buildExport,
        parseImport: parseImport
    };
});
