const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const history = require("../js/history");
const { parseGradeHistory, normalizePeriod, termIndex, assignSemesters, normalizeDistribution } = history;

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "grade-history-synthetic.txt"), "utf8");

const HEADER = ["Sl.No.", "Course Code", "Course Title", "Course Type", "Credits", "Grade",
                "Exam Month", "Result Declared", "Course Distribution", "Detail View"];

// One data row in the standard column order.
const row = (code, title, credits, grade, month, distribution, extra = {}) => [
    extra.serial ?? "1", code, title, extra.type ?? "Theory Only", credits, grade, month,
    extra.declared ?? "", distribution, "View",
];
const tsv = (rows, header = HEADER) => [header].concat(rows).map(r => r.join("\t")).join("\n");

const periodOf = text => normalizePeriod(text);

// --- the supplied column structure ---------------------------------------------------------

test("parses the synthetic grade table with every supplied column", () => {
    const r = parseGradeHistory(FIXTURE);
    assert.equal(r.headerFound, true);
    assert.equal(r.headerLine, 3, "the two preamble lines are skipped");
    assert.equal(r.error, null);
    assert.equal(r.rows.length, 6);
    assert.deepEqual(r.rejected, []);

    const dsa = r.rows.find(x => x.code === "BCSE202L");
    assert.equal(dsa.title, "Data Structures and Algorithms");
    assert.equal(dsa.type, "Theory Only");
    assert.equal(dsa.credits, 3);
    assert.equal(dsa.grade, "A");
    assert.equal(dsa.period.key, "2025-04");
    assert.equal(dsa.period.label, "Apr-2025");
    assert.equal(dsa.resultDeclared, "20-May-2025");
    assert.equal(dsa.distribution, "PC");
    assert.equal(dsa.isNgcr, false);
    assert.equal(dsa.serial, "1");
});

test("the NGCR row keeps its code, title, credits, grade, exam month and metadata", () => {
    const ethics = parseGradeHistory(FIXTURE).rows.find(x => x.code === "BHUM101L");
    assert.equal(ethics.isNgcr, true);
    assert.equal(ethics.distribution, "NGCR");
    assert.equal(ethics.title, "Ethics and Values");
    assert.equal(ethics.credits, 2, "displayed credits are preserved even though they will not count");
    assert.equal(ethics.grade, "P");
    assert.equal(ethics.period.key, "2024-11");
    assert.equal(ethics.resultDeclared, "30-Dec-2024");
});

test("blank cells stay blank: an empty Result Declared is '' and a decimal credit is kept", () => {
    const r = parseGradeHistory(FIXTURE);
    assert.equal(r.rows.find(x => x.code === "BSTS301P").resultDeclared, "");
    assert.equal(r.rows.find(x => x.code === "BCSE202P").credits, 1.5);
    assert.equal(r.rows.find(x => x.code === "BCSE399J").credits, 0.5);
});

test("page furniture after the table is reported as ignored, not parsed and not hidden", () => {
    const r = parseGradeHistory(FIXTURE);
    assert.deepEqual(r.ignored.map(i => [i.line, i.reason]), [[10, "not a table row"]]);
    assert.match(r.ignored[0].text, /Showing 1 to 6 of 6 entries/);
});

// --- header handling -----------------------------------------------------------------------

test("columns are found by header name, so their order does not matter", () => {
    const shuffled = ["Grade", "Course Title", "Exam Month", "Course Code", "Credits", "Course Distribution"];
    const cell = { "Grade": "A", "Course Title": "Data Structures", "Exam Month": "Nov-2024",
                   "Course Code": "BCSE202L", "Credits": "3", "Course Distribution": "PC" };
    const r = parseGradeHistory([shuffled.join("\t"), shuffled.map(h => cell[h]).join("\t")].join("\n"));
    assert.equal(r.rows.length, 1);
    assert.deepEqual(
        [r.rows[0].code, r.rows[0].title, r.rows[0].credits, r.rows[0].grade, r.rows[0].period.key],
        ["BCSE202L", "Data Structures", 3, "A", "2024-11"]);
});

test("optional columns can be absent", () => {
    const header = ["Course Code", "Course Title", "Credits", "Grade", "Exam Month"];
    const r = parseGradeHistory([header.join("\t"), ["BCSE202L", "Data Structures", "3", "A", "Nov-2024"].join("\t")].join("\n"));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].distribution, "");
    assert.equal(r.rows[0].isNgcr, false);
    assert.equal(r.rows[0].resultDeclared, "");
});

test("header names tolerate case, dots, spaces and punctuation", () => {
    const header = ["S.No.", "COURSE  CODE", "course title", "Credits", "GRADE", "Exam-Month"];
    const r = parseGradeHistory([header.join("\t"), ["1", "BCSE202L", "Data Structures", "3", "A", "Nov-2024"].join("\t")].join("\n"));
    assert.equal(r.rows.length, 1);
});

test("a repeated header row (two pages pasted together) is ignored and reported", () => {
    const text = tsv([row("BCSE202L", "Data Structures", "3", "A", "Nov-2024", "PC")]) + "\n" + HEADER.join("\t") + "\n" +
        row("BMAT201L", "Calculus", "4", "B", "Nov-2024", "UC").join("\t");
    const r = parseGradeHistory(text);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.ignored.map(i => i.reason), ["repeated header row"]);
});

test("no header row: a clear error and no rows", () => {
    for (const text of ["BCSE202L\tData Structures\t3\tA\tNov-2024", "hello world", "Course Code\nGrade\nCredits"]) {
        const r = parseGradeHistory(text);
        assert.equal(r.headerFound, false, text);
        assert.deepEqual(r.rows, []);
        assert.match(r.error, /header/i);
    }
});

test("a header that lacks a required column says which one", () => {
    const header = ["Course Code", "Course Title", "Credits", "Exam Month"];
    const r = parseGradeHistory([header.join("\t"), "BCSE202L\tData Structures\t3\tNov-2024"].join("\n"));
    assert.equal(r.headerFound, false);
    assert.match(r.error, /Grade/);
});

test("empty, null and undefined input give an error rather than throwing", () => {
    for (const input of ["", "   \n\n", null, undefined]) {
        const r = parseGradeHistory(input);
        assert.equal(r.headerFound, false);
        assert.ok(r.error);
        assert.deepEqual(r.rows, []);
    }
});

test("an absurdly long paste is refused", () => {
    const r = parseGradeHistory("x\n".repeat(5000));
    assert.match(r.error, /too much text/);
});

// --- whitespace and formatting --------------------------------------------------------------

test("Windows line endings, a BOM and non-breaking spaces give the same rows", () => {
    const plain = parseGradeHistory(FIXTURE).rows;
    const messy = "﻿" + FIXTURE.replace(/\n/g, "\r\n").replace(/Data Structures/g, "Data Structures");
    assert.deepEqual(parseGradeHistory(messy).rows.map(r => [r.code, r.credits, r.grade, r.period.key]),
                     plain.map(r => [r.code, r.credits, r.grade, r.period.key]));
});

test("extra spaces inside cells are collapsed and codes are normalised", () => {
    const r = parseGradeHistory(tsv([row("  bcse 202l ", "  Data    Structures   ", " 3 ", " a ", " nov - 2024 ", " pc ")]));
    assert.equal(r.rows.length, 1);
    const x = r.rows[0];
    assert.deepEqual([x.code, x.title, x.credits, x.grade, x.period.key, x.distribution], ["BCSE202L", "Data Structures", 3, "A", "2024-11", "PC"]);
});

test("trailing empty cells that were cut off by the clipboard are treated as empty", () => {
    const line = ["1", "BCSE202L", "Data Structures", "Theory Only", "3", "A", "Nov-2024"].join("\t");   // no declared/distribution/detail
    const r = parseGradeHistory(HEADER.join("\t") + "\n" + line);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].distribution, "");
    assert.equal(r.rows[0].resultDeclared, "");
});

test("a blank leading Sl.No. cell does not shift the other columns", () => {
    const r = parseGradeHistory(tsv([row("BCSE202L", "Data Structures", "3", "A", "Nov-2024", "PC", { serial: "" })]));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].code, "BCSE202L");
    assert.equal(r.rows[0].serial, "");
});

test("blank lines between rows are skipped quietly", () => {
    const text = tsv([row("BCSE202L", "Data Structures", "3", "A", "Nov-2024", "PC")]) + "\n\n   \n" +
        row("BMAT201L", "Calculus", "4", "B", "Nov-2024", "UC").join("\t");
    const r = parseGradeHistory(text);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.ignored, []);
});

test("columns separated by runs of spaces (tabs lost in copying) are still read", () => {
    const text = [
        "Sl.No.  Course Code  Course Title  Course Type  Credits  Grade  Exam Month  Result Declared  Course Distribution  Detail View",
        "1  BCSE202L  Data Structures and Algorithms  Theory Only  3  A  Nov-2024  30-Dec-2024  PC  View",
    ].join("\n");
    const r = parseGradeHistory(text);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].title, "Data Structures and Algorithms");
    assert.equal(r.rows[0].period.key, "2024-11");
});

test("space-separated rows with a blank cell are rejected, not misaligned", () => {
    const text = [
        "Sl.No.  Course Code  Course Title  Course Type  Credits  Grade  Exam Month  Result Declared  Course Distribution  Detail View",
        "1  BCSE202L  Data Structures  Theory Only  3  A  Nov-2024    PC  View",    // empty Result Declared
    ].join("\n");
    const r = parseGradeHistory(text);
    assert.equal(r.rows.length, 0, "must not guess which cell is missing");
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reasons[0], /separated by tabs/);
});

// --- missing and invalid cells are reported ---------------------------------------------------

test("rows that cannot be read are rejected with their line number and reasons, and good rows still import", () => {
    const text = tsv([
        row("BCSE202L", "Data Structures", "3", "A", "Nov-2024", "PC"),               // line 2: fine
        row("???", "Mystery", "3", "A", "Nov-2024", "PC"),                            // line 3: bad code
        row("BMAT201L", "", "4", "B", "Nov-2024", "UC"),                              // line 4: no title
        row("BPHY101L", "Physics", "abc", "B", "Nov-2024", "UC"),                     // line 5: credits not a number
        row("BCHY101L", "Chemistry", "", "B", "Nov-2024", "UC"),                      // line 6: credits missing
        row("BENG101L", "English", "3", "B", "Foo-2024", "UC"),                       // line 7: month not recognised
        row("BENG102L", "English 2", "3", "B", "Nov-24", "UC"),                       // line 8: 2-digit year refused
        row("BENG103L", "English 3", "3", "B", "", "UC"),                             // line 9: no exam month
    ]);
    const r = parseGradeHistory(text);
    assert.deepEqual(r.rows.map(x => x.code), ["BCSE202L"]);
    assert.deepEqual(r.rejected.map(x => x.line), [3, 4, 5, 6, 7, 8, 9]);
    assert.match(r.rejected[0].reasons.join(), /course code/);
    assert.match(r.rejected[1].reasons.join(), /title is missing/);
    assert.match(r.rejected[2].reasons.join(), /not a number/);
    assert.match(r.rejected[3].reasons.join(), /credits are missing/);
    assert.match(r.rejected[4].reasons.join(), /not recognised/);
    assert.match(r.rejected[5].reasons.join(), /not recognised/);
    assert.match(r.rejected[6].reasons.join(), /missing/);
    r.rejected.forEach(x => assert.ok(x.text.length > 0, "the offending text is shown"));
});

test("a row with several problems lists every one of them", () => {
    const r = parseGradeHistory(tsv([row("", "", "x", "A", "", "PC")]));
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].reasons.length, 4);
});

test("rejected rows keep their code and period when those were readable (used to spot newer unreadable attempts)", () => {
    const r = parseGradeHistory(tsv([row("BCSE202L", "Data Structures", "oops", "A", "Apr-2025", "PC")]));
    assert.equal(r.rejected[0].code, "BCSE202L");
    assert.equal(r.rejected[0].periodKey, "2025-04");
});

test("a row with more cells than the header is rejected", () => {
    const r = parseGradeHistory(HEADER.join("\t") + "\n" + row("BCSE202L", "Data Structures", "3", "A", "Nov-2024", "PC").concat(["extra"]).join("\t"));
    assert.equal(r.rows.length, 0);
    assert.match(r.rejected[0].reasons[0], /11 cells/);
});

test("an NGCR row may have blank credits and any grade text; it is not fabricated", () => {
    const r = parseGradeHistory(tsv([
        row("BHUM101L", "Ethics", "", "P", "Nov-2024", "NGCR"),
        row("BHUM102L", "Values", "2", "", "Nov-2024", "NGCR"),
    ]));
    assert.equal(r.rejected.length, 0);
    assert.equal(r.rows[0].credits, null);
    assert.equal(r.rows[0].grade, "P");
    assert.equal(r.rows[1].credits, 2);
    assert.equal(r.rows[1].grade, "");
});

test("a graded row with a blank grade is read as grade '' (the model decides it is unusable)", () => {
    const r = parseGradeHistory(tsv([row("BCSE202L", "Data Structures", "3", "", "Nov-2024", "PC")]));
    assert.equal(r.rows[0].grade, "");
});

// --- course distribution ---------------------------------------------------------------------

test("NGCR is recognised from the distribution cell only", () => {
    assert.equal(normalizeDistribution("NGCR"), "NGCR");
    assert.equal(normalizeDistribution(" ngcr "), "NGCR");
    assert.equal(normalizeDistribution("Non-Graded Core Requirement"), "NGCR");
    assert.equal(normalizeDistribution("PC"), "PC");
    assert.equal(normalizeDistribution(""), "");

    // not by grade, credits, name or type
    const r = parseGradeHistory(tsv([
        row("BHUM101L", "Non-Graded Core Requirement Seminar", "2", "P", "Nov-2024", "PC", { type: "NGCR" }),
        row("BHUM102L", "Ethics", "2", "P", "Nov-2024", "UC"),
    ]));
    assert.deepEqual(r.rows.map(x => x.isNgcr), [false, false]);
});

// --- exam periods -----------------------------------------------------------------------------

test("period text is normalised to a year-month key and a label", () => {
    for (const [input, key, label] of [
        ["Nov-2024", "2024-11", "Nov-2024"], ["NOV-2024", "2024-11", "Nov-2024"], ["nov 2024", "2024-11", "Nov-2024"],
        ["November-2024", "2024-11", "Nov-2024"], ["Nov/2024", "2024-11", "Nov-2024"], ["Nov. 2024", "2024-11", "Nov-2024"],
        ["2024-Nov", "2024-11", "Nov-2024"], ["11/2024", "2024-11", "Nov-2024"], ["2024-11", "2024-11", "Nov-2024"],
        ["Apr-2025", "2025-04", "Apr-2025"], ["April 2025", "2025-04", "Apr-2025"], ["  Apr - 2025 ", "2025-04", "Apr-2025"],
        ["May-2025", "2025-05", "May-2025"], ["Sept-2025", "2025-09", "Sep-2025"],
    ]) {
        const p = normalizePeriod(input);
        assert.equal(p.ok, true, input);
        assert.equal(p.key, key, input);
        assert.equal(p.label, label, input);
    }
});

test("unreadable period text is refused rather than guessed", () => {
    for (const input of ["", "   ", "Foo-2024", "Nov", "2024", "Nov-24", "13/2024", "0/2024", "Nov-1999", "Nov-2024-1", null, undefined]) {
        assert.equal(normalizePeriod(input).ok, false, JSON.stringify(input));
    }
});

test("termIndex puts November and April on one consecutive half-year line and refuses other months", () => {
    const t = s => termIndex(periodOf(s));
    assert.equal(t("Apr-2025") - t("Nov-2024"), 1);
    assert.equal(t("Nov-2025") - t("Apr-2025"), 1);
    assert.equal(t("Apr-2026") - t("Nov-2025"), 1);
    assert.equal(t("Apr-2026") - t("Nov-2024"), 3);
    for (const s of ["May-2025", "Jun-2025", "Dec-2024", "Jan-2025"]) assert.equal(t(s), null, s);
    assert.equal(termIndex({ ok: false }), null);
});

// --- semester assignment -----------------------------------------------------------------------

const assign = (texts, opts) => assignSemesters(texts.map(periodOf), opts);

test("the documented example: Nov-2024 -> 1, Apr-2025 -> 2, Nov-2025 -> 3, Apr-2026 -> 4", () => {
    const a = assign(["Nov-2024", "Apr-2025", "Nov-2025", "Apr-2026"]);
    assert.deepEqual(a.assignments, { "2024-11": 1, "2025-04": 2, "2025-11": 3, "2026-04": 4 });
    assert.deepEqual(a.unsupported, []);
    assert.equal(a.anchor.source, "earliest");
});

test("numbering follows time, not the order the periods appear in the table", () => {
    const forward = assign(["Nov-2024", "Apr-2025", "Nov-2025", "Apr-2026"]).assignments;
    for (const shuffled of [["Apr-2026", "Nov-2024", "Nov-2025", "Apr-2025"], ["Nov-2025", "Apr-2026", "Apr-2025", "Nov-2024"]]) {
        assert.deepEqual(assign(shuffled).assignments, forward);
    }
});

test("rows sharing an exam period share a semester number (repeats collapse)", () => {
    const a = assign(["Nov-2024", "Nov-2024", "NOV-2024", "Apr-2025", "Apr-2025"]);
    assert.deepEqual(a.assignments, { "2024-11": 1, "2025-04": 2 });
});

test("missing semesters keep their place: later semesters are not renumbered", () => {
    const a = assign(["Nov-2024", "Apr-2026"]);
    assert.deepEqual(a.assignments, { "2024-11": 1, "2026-04": 4 });
    assert.equal(Object.keys(a.assignments).includes("2025-04"), false, "Semesters 2 and 3 get no data");
});

test("the earliest period sets the first number: an April start is Semester 2", () => {
    assert.deepEqual(assign(["Apr-2025", "Nov-2025"]).assignments, { "2025-04": 2, "2025-11": 3 });
});

test("a saved anchor wins over the earliest period in this paste", () => {
    // Semester 3 is already known to be Nov-2025; pasting only Apr-2026 must give Semester 4, not 2.
    const a = assign(["Apr-2026"], { anchor: { key: "2025-11", semester: 3 } });
    assert.deepEqual(a.assignments, { "2026-04": 4 });
    assert.equal(a.anchor.source, "saved");
    // and an earlier period than the anchor numbers backwards
    assert.deepEqual(assign(["Apr-2025"], { anchor: { key: "2025-11", semester: 3 } }).assignments, { "2025-04": 2 });
});

test("unsupported months are flagged, not assigned, and do not disturb the others", () => {
    const a = assign(["Nov-2024", "May-2025", "Apr-2025", "Dec-2024"]);
    assert.deepEqual(a.assignments, { "2024-11": 1, "2025-04": 2 });
    assert.deepEqual(a.unsupported.map(u => u.key), ["2024-12", "2025-05"]);
    assert.match(a.unsupported[0].reason, /November \(odd\) or April \(even\)/);
});

test("periods that fall outside Semesters 1-8 are flagged, not clamped", () => {
    const a = assign(["Nov-2024", "Apr-2029"]);          // Apr-2029 would be Semester 10
    assert.deepEqual(a.assignments, { "2024-11": 1 });
    assert.match(a.unsupported[0].reason, /Semester 10/);

    const before = assign(["Apr-2024"], { anchor: { key: "2024-11", semester: 1 } });   // would be Semester 0
    assert.deepEqual(before.assignments, {});
    assert.match(before.unsupported[0].reason, /Semester 0/);
});

test("only unsupported periods: nothing assigned and no anchor invented", () => {
    const a = assign(["May-2025"]);
    assert.deepEqual(a.assignments, {});
    assert.equal(a.anchor, null);
});

test("empty or invalid period lists are handled", () => {
    assert.deepEqual(assignSemesters([]).assignments, {});
    assert.deepEqual(assignSemesters(undefined).assignments, {});
    assert.deepEqual(assignSemesters([{ ok: false }, null]).assignments, {});
});

test("the fixture's periods map to Semesters 1-4 in time order", () => {
    const r = parseGradeHistory(FIXTURE);
    const a = assignSemesters(r.rows.map(x => x.period));
    assert.deepEqual(a.assignments, { "2024-11": 1, "2025-04": 2, "2025-11": 3, "2026-04": 4 });
    const bySem = {};
    r.rows.forEach(x => { (bySem[a.assignments[x.period.key]] = bySem[a.assignments[x.period.key]] || []).push(x.code); });
    assert.deepEqual(bySem[1].sort(), ["BHUM101L", "BMAT201L"]);
    assert.deepEqual(bySem[2].sort(), ["BCSE202L", "BCSE202P"]);
});
