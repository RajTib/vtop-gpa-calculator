/*
 * VTOP grade-history parsing and exam-period -> semester mapping (pure: no DOM, no storage).
 *
 * Input is the text a student copies from the VTOP Effective Grades / grade-history table:
 *   Sl.No. | Course Code | Course Title | Course Type | Credits | Grade | Exam Month |
 *   Result Declared | Course Distribution | Detail View
 *
 * Rules:
 *   - The header row is found by its column names, so column order and extra or missing
 *     optional columns do not matter. Rows are read through that header, never by fixed position.
 *   - A row is only accepted when its required cells are present and look right. Anything else
 *     is returned in `rejected` with the reasons; lines that are not table rows at all (page
 *     furniture such as "Showing 1 to 10 of 10 entries") are returned in `ignored`. Nothing is
 *     dropped silently and no missing value is invented.
 *   - This module only EXTRACTS. Whether a grade is supported, which semester a row belongs to
 *     and how it merges with existing data is decided by the model (js/model.js).
 *
 * Semester mapping (assignSemesters): November exams are odd semesters and April exams are even
 * ones, numbered chronologically. Periods with no data keep their place, so a gap is a gap.
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports;
    var api = factory();
    if (isNode) {
        module.exports = api;
    } else {
        root.VtopGpa = root.VtopGpa || {};
        root.VtopGpa.history = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    var NGCR = "NGCR";
    var MAX_TEXT = 120;
    var MAX_DISTRIBUTION = 40;
    var MAX_TYPE = 40;
    var MAX_DECLARED = 30;
    var MAX_LINES = 2000;          // a degree has a few hundred rows at most; stop runaway pastes

    // Header text, reduced to lowercase letters and digits, -> the field it names.
    var HEADERS = {
        slno: "serial", sno: "serial", serialno: "serial",
        coursecode: "code", code: "code",
        coursetitle: "title", coursename: "title", title: "title",
        coursetype: "type", type: "type",
        credits: "credits", credit: "credits",
        grade: "grade",
        exammonth: "month", examperiod: "month", month: "month",
        resultdeclared: "declared", resultdeclaredon: "declared", declaredon: "declared",
        coursedistribution: "distribution", distribution: "distribution",
        detailview: "detail"
    };
    var REQUIRED = ["code", "title", "credits", "grade", "month"];
    var LABELS = { code: "Course Code", title: "Course Title", credits: "Credits", grade: "Grade", month: "Exam Month" };

    // Letters, then 3-4 digits, then up to two letters (BCSE202L, CSE1001, BSTS301P ...).
    var CODE_RE = /^[A-Z]{2,6}\d{3,4}[A-Z]{0,2}$/;

    var MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    var MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var MONTH_WORDS = {
        january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8,
        september: 9, sept: 9, october: 10, november: 11, december: 12
    };
    MONTH_NAMES.forEach(function (m, i) { MONTH_WORDS[m] = i + 1; });

    // ---- small helpers -----------------------------------------------------------------------

    function clean(s, max) {
        var t = String(s === undefined || s === null ? "" : s)
            .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
            .replace(/[\s ]+/g, " ").trim();
        return max ? t.slice(0, max) : t;
    }

    function headerKey(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    // Course codes are compared in this form: upper case, no spaces.
    function normalizeCode(s) {
        return String(s === undefined || s === null ? "" : s).replace(/[\s ]+/g, "").toUpperCase();
    }

    // The distribution is kept as text (upper case); only "NGCR" (or its full name) has a meaning.
    function normalizeDistribution(s) {
        var t = clean(s, MAX_DISTRIBUTION).toUpperCase();
        if (t === NGCR || /^NON[\s-]*GRADED CORE REQUIREMENT$/.test(t)) return NGCR;
        return t;
    }

    // One table line -> cells. Tabs are the real clipboard format; if a line has none, runs of 2+
    // spaces are used. Only spaces are trimmed from the ends, so empty leading/trailing cells survive.
    function splitCells(line) {
        var s = line.replace(/ /g, " ").replace(/^ +| +$/g, "");
        var mode = "single", parts = [s];
        if (s.indexOf("\t") !== -1) { mode = "tab"; parts = s.split("\t"); }
        else if (/ {2,}/.test(s)) { mode = "space"; parts = s.split(/ {2,}/); }
        return { mode: mode, cells: parts.map(function (p) { return clean(p); }) };
    }

    function mapHeader(cells) {
        var columns = {}, found = 0;
        cells.forEach(function (c, i) {
            var field = HEADERS[headerKey(c)];
            if (field && columns[field] === undefined) { columns[field] = i; found++; }
        });
        return { columns: columns, found: found };
    }

    // ---- exam periods ------------------------------------------------------------------------

    // "Nov-2024", "NOV 2024", "November-2024", "11/2024", "2024-11" -> { ok, year, month, key, label }.
    // Two-digit years are refused rather than guessed.
    function normalizePeriod(text) {
        var t = clean(text);
        if (!t) return { ok: false, reason: "exam month is missing" };
        var month = null, year = null, m;

        if ((m = t.match(/^([A-Za-z]{3,9})\.?[\s\-\/,.]*(\d{4})$/))) {
            month = MONTH_WORDS[m[1].toLowerCase()] || null; year = Number(m[2]);
        } else if ((m = t.match(/^(\d{4})[\s\-\/,.]*([A-Za-z]{3,9})\.?$/))) {
            month = MONTH_WORDS[m[2].toLowerCase()] || null; year = Number(m[1]);
        } else if ((m = t.match(/^(\d{1,2})\s*[\-\/]\s*(\d{4})$/))) {
            month = Number(m[1]); year = Number(m[2]);
        } else if ((m = t.match(/^(\d{4})\s*[\-\/]\s*(\d{1,2})$/))) {
            month = Number(m[2]); year = Number(m[1]);
        }
        if (!month || month < 1 || month > 12 || !year || year < 2000 || year > 2100) {
            return { ok: false, reason: "exam month “" + t.slice(0, 30) + "” is not recognised (expected e.g. Nov-2024)" };
        }
        return {
            ok: true, year: year, month: month,
            key: year + "-" + (month < 10 ? "0" : "") + month,
            label: MONTH_LABELS[month - 1] + "-" + year
        };
    }

    // Position of a period in the half-year sequence, or null when it is not a supported period.
    // Nov-Y and the following Apr-(Y+1) are neighbours: Nov-2024 -> 4048, Apr-2025 -> 4049,
    // Nov-2025 -> 4050, Apr-2026 -> 4051. Other months (May, Jun, Dec ...) are not mapped.
    function termIndex(period) {
        if (!period || !period.ok) return null;
        if (period.month === 11) return 2 * period.year;
        if (period.month === 4) return 2 * period.year - 1;
        return null;
    }

    // periods: [{ ok, key, label, year, month }] (repeats are fine).
    // opts.anchor: { key, semester } - a period whose semester number is already known (from
    //              data saved earlier). Without it the earliest supported period is the anchor:
    //              November -> Semester 1, April -> Semester 2.
    // opts.maxSemester: highest semester number the app can hold (default 8).
    // Returns { assignments: { key: number }, unsupported: [{ key, label, reason }], anchor }.
    function assignSemesters(periods, opts) {
        opts = opts || {};
        var max = opts.maxSemester || 8;
        var byKey = {};
        (periods || []).forEach(function (p) { if (p && p.ok && !byKey[p.key]) byKey[p.key] = p; });

        var sorted = Object.keys(byKey).sort().map(function (k) { return byKey[k]; });   // chronological
        var out = { assignments: {}, unsupported: [], anchor: null };
        var supported = [];

        sorted.forEach(function (p) {
            if (termIndex(p) === null) {
                out.unsupported.push({ key: p.key, label: p.label,
                    reason: p.label + " is not a November (odd) or April (even) exam period" });
            } else {
                supported.push(p);
            }
        });
        if (!supported.length) return out;

        var anchorP = null, anchorSem = null, source = "earliest";
        var given = opts.anchor && opts.anchor.key ? normalizePeriod(opts.anchor.key) : null;
        if (given && termIndex(given) !== null && Number.isInteger(opts.anchor.semester)) {
            anchorP = given; anchorSem = opts.anchor.semester; source = "saved";
        } else {
            anchorP = supported[0];
            anchorSem = anchorP.month === 11 ? 1 : 2;
        }
        var anchorT = termIndex(anchorP);
        out.anchor = { key: anchorP.key, label: anchorP.label, semester: anchorSem, source: source };

        supported.forEach(function (p) {
            var n = anchorSem + (termIndex(p) - anchorT);
            if (n < 1 || n > max) {
                out.unsupported.push({ key: p.key, label: p.label,
                    reason: p.label + " would be Semester " + n + ", outside Semesters 1-" + max });
            } else {
                out.assignments[p.key] = n;
            }
        });
        out.unsupported.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
        return out;
    }

    // ---- the grade table ---------------------------------------------------------------------

    function parseCredits(text) {
        var t = clean(text);
        if (t === "") return { blank: true, value: null };
        if (!/^\d+(\.\d{1,2})?$/.test(t)) return { blank: false, invalid: true, text: t };
        return { blank: false, value: Number(t) };
    }

    // Returns {
    //   headerFound, headerLine, columns, error,
    //   rows:     [{ line, raw, serial, code, title, type, credits|null, grade, period, resultDeclared,
    //                distribution, isNgcr }],
    //   rejected: [{ line, text, reasons: [...], code?, periodKey? }],
    //   ignored:  [{ line, text, reason }]
    // }
    function parseGradeHistory(raw) {
        var res = { headerFound: false, headerLine: null, columns: {}, error: null, rows: [], rejected: [], ignored: [] };
        var text = String(raw === undefined || raw === null ? "" : raw).replace(/^﻿/, "");
        var lines = text.split(/\r\n|\r|\n/);
        if (lines.length > MAX_LINES) {
            res.error = "That is too much text to be a grade table (more than " + MAX_LINES + " lines).";
            return res;
        }
        if (!text.trim()) { res.error = "Paste your grade history table first."; return res; }

        var header = null, missing = null;
        for (var i = 0; i < lines.length && !header; i++) {
            var split = splitCells(lines[i]);
            var mapped = mapHeader(split.cells);
            if (mapped.found >= 3 && mapped.columns.code !== undefined) {
                var lacking = REQUIRED.filter(function (f) { return mapped.columns[f] === undefined; });
                if (lacking.length) { missing = lacking; continue; }
                header = { index: i, columns: mapped.columns, width: split.cells.length };
            }
        }
        if (!header) {
            res.error = missing
                ? "The header row is missing these columns: " + missing.map(function (f) { return LABELS[f]; }).join(", ") + "."
                : "Could not find the table header. Copy the table including its header row " +
                  "(Course Code, Course Title, Credits, Grade, Exam Month …) so the columns paste separated by tabs.";
            return res;
        }
        res.headerFound = true;
        res.headerLine = header.index + 1;
        res.columns = header.columns;

        for (var n = header.index + 1; n < lines.length; n++) {
            var rawLine = lines[n];
            if (!rawLine.replace(/[\s ]+/g, "")) continue;               // blank line
            var lineNo = n + 1;
            var parts = splitCells(rawLine);

            if (mapHeader(parts.cells).found >= 3) {
                res.ignored.push({ line: lineNo, text: clean(rawLine, MAX_TEXT), reason: "repeated header row" });
                continue;
            }
            var hasCode = parts.cells.some(function (c) { return CODE_RE.test(normalizeCode(c)); });
            if (parts.cells.length < 3 && !hasCode) {
                res.ignored.push({ line: lineNo, text: clean(rawLine, MAX_TEXT), reason: "not a table row" });
                continue;
            }
            readRow(res, header, parts, rawLine, lineNo);
        }
        return res;
    }

    function readRow(res, header, parts, rawLine, lineNo) {
        var cells = parts.cells, cols = header.columns, reasons = [];
        var shown = clean(rawLine, MAX_TEXT);

        if (cells.length > header.width) {
            res.rejected.push({ line: lineNo, text: shown, reasons: ["has " + cells.length + " cells but the header has " + header.width] });
            return;
        }
        if (cells.length < header.width) {
            if (parts.mode !== "tab") {
                res.rejected.push({ line: lineNo, text: shown, reasons: [
                    "its columns could not be told apart (" + cells.length + " cells, expected " + header.width +
                    "); copy the table again so columns are separated by tabs"] });
                return;
            }
            while (cells.length < header.width) cells.push("");               // trailing empty cells
        }
        function cell(field) { return cols[field] === undefined ? "" : cells[cols[field]]; }

        var code = normalizeCode(cell("code"));
        var codeOk = CODE_RE.test(code);
        if (!codeOk) reasons.push(code ? "course code “" + code.slice(0, 20) + "” is not recognised" : "course code is missing");

        var title = clean(cell("title"), MAX_TEXT);
        if (!title) reasons.push("course title is missing");

        var distribution = normalizeDistribution(cell("distribution"));
        var isNgcr = distribution === NGCR;

        var credits = parseCredits(cell("credits"));
        if (credits.invalid) reasons.push("credits “" + credits.text.slice(0, 20) + "” is not a number");
        else if (credits.blank && !isNgcr) reasons.push("credits are missing");

        var grade = clean(cell("grade"), 12).toUpperCase();

        var period = normalizePeriod(cell("month"));
        if (!period.ok) reasons.push(period.reason);

        if (reasons.length) {
            var rej = { line: lineNo, text: shown, reasons: reasons };
            if (codeOk) rej.code = code;
            if (period.ok) rej.periodKey = period.key;
            res.rejected.push(rej);
            return;
        }
        res.rows.push({
            line: lineNo,
            raw: shown,
            serial: clean(cell("serial"), 10),
            code: code,
            title: title,
            type: clean(cell("type"), MAX_TYPE),
            credits: credits.value,
            grade: grade,
            period: period,
            resultDeclared: clean(cell("declared"), MAX_DECLARED),
            distribution: distribution,
            isNgcr: isNgcr
        });
    }

    return {
        NGCR: NGCR,
        MAX_DISTRIBUTION: MAX_DISTRIBUTION,
        MAX_TYPE: MAX_TYPE,
        MAX_DECLARED: MAX_DECLARED,
        parseGradeHistory: parseGradeHistory,
        normalizePeriod: normalizePeriod,
        normalizeCode: normalizeCode,
        normalizeDistribution: normalizeDistribution,
        termIndex: termIndex,
        assignSemesters: assignSemesters
    };
});
