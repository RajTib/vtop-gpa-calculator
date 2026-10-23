const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseTimetable } = require("../js/parser");
const { legacyParse } = require("./legacy-parser");

const SAMPLE = fs.readFileSync(path.join(__dirname, "fixtures", "timetable-synthetic.txt"), "utf8");

// What the old parser exposed. The new parser may add fields (code, creditMissing)
// but must not change these.
const legacyShape = s => ({ course: s.course, credit: s.credit, category: s.category });

test("subjects are identical to the frozen legacy parser on the sample timetable", () => {
    const next = parseTimetable(SAMPLE).subjects.map(legacyShape);
    assert.deepEqual(next, legacyParse(SAMPLE).map(legacyShape));
});

test("sample timetable: names, credits and ordering", () => {
    const { subjects } = parseTimetable(SAMPLE);
    assert.deepEqual(subjects.map(s => [s.course, s.credit]), [
        ["Complex Variables and Linear Algebra", 4],
        ["Data Structures and Algorithms", 3],
        ["Data Structures and Algorithms Lab", 1.5],
        ["Advanced Competitive Coding - I", 1],
        ["Project - Phase 1", 0.5],
    ]);
});

test("sample timetable: course codes are captured without altering the name", () => {
    const { subjects } = parseTimetable(SAMPLE);
    assert.equal(subjects.find(s => s.course === "Data Structures and Algorithms").code, "BCSE202L");
    assert.equal(subjects.find(s => s.course === "Data Structures and Algorithms Lab").code, "BCSE202P");
});

test("non-graded courses are excluded from subjects but reported in skipped", () => {
    const { subjects, skipped } = parseTimetable(SAMPLE);
    assert.ok(!subjects.some(s => /Ethics/.test(s.course)));
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].course, "Ethics and Values");
    assert.equal(skipped[0].code, "BHUM101L");
});

test("hyphens inside course names are preserved", () => {
    const { subjects } = parseTimetable(SAMPLE);
    assert.ok(subjects.some(s => s.course === "Advanced Competitive Coding - I"));
});

test("Windows line endings give the same result", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    assert.deepEqual(parseTimetable(crlf).subjects, parseTimetable(SAMPLE).subjects);
});

test("empty and junk input parse to nothing without throwing", () => {
    for (const input of ["", "   \n\n", "hello world", null, undefined]) {
        const r = parseTimetable(input);
        assert.deepEqual(r.subjects, []);
        assert.deepEqual(r.warnings, []);
    }
});

test("a course with no LTPC line keeps credit 0 (legacy parity) but is flagged creditMissing", () => {
    const text = [
        "BCSE101L - Mystery Course",
        "Programme Core",
        "Registered and Approved",
    ].join("\n");
    const { subjects } = parseTimetable(text);
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].credit, 0);
    assert.equal(subjects[0].creditMissing, true);
    assert.deepEqual(parseTimetable(text).subjects.map(legacyShape), legacyParse(text).map(legacyShape));
});

test("a real credit of 0 is not flagged as missing", () => {
    const text = [
        "BCSE102L - Zero Credit Course",
        "0 0 0 0 0",
        "Programme Core",
        "Registered and Approved",
    ].join("\n");
    const { subjects } = parseTimetable(text);
    assert.equal(subjects[0].credit, 0);
    assert.equal(subjects[0].creditMissing, undefined);
});

test("blocks the legacy parser dropped silently now produce warnings (subjects unchanged)", () => {
    const text = [
        "BCSE201L - Dropped Because New Course Starts",
        "3 0 0 0 3",
        "BCSE202L - Kept",
        "2 0 0 0 2",
        "Programme Core",
        "Registered and Approved",
        "BCSE203L - Never Terminated",
        "3 0 0 0 3",
    ].join("\n");
    const r = parseTimetable(text);
    assert.deepEqual(r.subjects.map(legacyShape), legacyParse(text).map(legacyShape));
    assert.deepEqual(r.subjects.map(s => s.course), ["Kept"]);
    assert.deepEqual(r.warnings.map(w => w.course), ["Dropped Because New Course Starts", "Never Terminated"]);
});

test("known legacy limitation, preserved: a bare 'Non-graded' category line without a keyword is not captured", () => {
    // The category must contain core/elective/requirement/sciences/skill/soft to be recorded.
    // A line that only says "Non-graded" is ignored, so the course would be COUNTED.
    // Behaviour is kept for parity; the app lets the user untick "counts toward GPA".
    const text = [
        "BXXX101L - Odd Category",
        "1 0 0 0 1",
        "Non-graded",
        "Registered and Approved",
    ].join("\n");
    assert.equal(parseTimetable(text).subjects.length, 1);
    assert.equal(legacyParse(text).length, 1);
});

// --- registration status: regular vs retake / grade improvement ---------------------------
const REGULAR = "Registered and Approved";
const RETAKE = "Registered, Invoice Generated, Fees Paid and Approved";

const block = (code, name, credit, status) => [
    code + " - " + name, "Theory Only", "3 0 0 0 " + credit + ".0", "Programme Core", "Dr. Example", status,
].join("\n");

test("regular registration status still ends a course block", () => {
    const r = parseTimetable(block("BCSE202L", "Data Structures", 3, REGULAR));
    assert.deepEqual(r.subjects.map(s => [s.code, s.course, s.credit]), [["BCSE202L", "Data Structures", 3]]);
    assert.deepEqual(r.warnings, []);
});

test("retake registration status ends a course block and extracts the same fields", () => {
    const retake = parseTimetable(block("BCSE202L", "Data Structures", 3, RETAKE));
    const regular = parseTimetable(block("BCSE202L", "Data Structures", 3, REGULAR));
    assert.deepEqual(retake.subjects, regular.subjects);
    assert.deepEqual(retake.warnings, []);
});

test("regular and retake registrations can be mixed in one timetable", () => {
    const text = [
        block("BCSE202L", "Data Structures", 3, REGULAR),
        block("BMAT201L", "Complex Variables", 4, RETAKE),
        block("BCSE202P", "Data Structures Lab", 1, REGULAR),
    ].join("\n");
    const r = parseTimetable(text);
    assert.deepEqual(r.subjects.map(s => s.code).sort(), ["BCSE202L", "BCSE202P", "BMAT201L"]);
    assert.deepEqual(r.warnings, []);
});

test("status matching tolerates case, extra spaces, tabs and non-breaking spaces", () => {
    for (const status of [
        "REGISTERED, INVOICE GENERATED, FEES PAID AND APPROVED",
        "Registered,  Invoice   Generated ,Fees Paid and Approved",
        "Registered, Invoice Generated,\tFees Paid and Approved",
        "registered and approved",
        "Registered  and \t Approved",
    ]) {
        assert.equal(parseTimetable(block("BCSE202L", "Data Structures", 3, status)).subjects.length, 1, JSON.stringify(status));
    }
});

test("statuses that are not an approved registration do not end a block", () => {
    for (const status of [
        "Registered, Invoice Generated and Fees Not Paid",
        "Registered, Invoice Generated, Fees Paid",
        "Registered and Waiting",
        "Invoice Generated, Fees Paid and Approved",
        "Registration Cancelled",
    ]) {
        const r = parseTimetable(block("BCSE202L", "Data Structures", 3, status));
        assert.equal(r.subjects.length, 0, JSON.stringify(status));
        assert.deepEqual(r.warnings.map(w => w.type), ["unterminated"], JSON.stringify(status));
    }
});

test("a retake of a non-graded course is still skipped, not imported", () => {
    const text = [
        "BHUM101L - Ethics and Values", "Theory Only", "2 0 0 0 2.0", "Non-graded Core Requirement", "Dr. Example", RETAKE,
    ].join("\n");
    const r = parseTimetable(text);
    assert.equal(r.subjects.length, 0);
    assert.deepEqual(r.skipped.map(s => s.code), ["BHUM101L"]);
});

test("isRegistrationStatus is exported and agrees with the parser", () => {
    const { isRegistrationStatus } = require("../js/parser");
    assert.equal(isRegistrationStatus(REGULAR), true);
    assert.equal(isRegistrationStatus(RETAKE), true);
    assert.equal(isRegistrationStatus("Registered and Waiting"), false);
});

// --- randomised equivalence against the legacy oracle -------------------------------------
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test("randomised line soups: subjects always equal the legacy parser's", () => {
    const pool = SAMPLE.split("\n").concat([
        "", "  ", "Soft Skill", "Registered and Approved", "random words", "12 13",
        "BAAA111L - Extra Course", "ABC - def", "XY123 - Loose Course", "3 0 0 0 3",
        "1.5", "Non-graded Core Requirement", "Open Elective",
    ]);
    const rnd = mulberry32(12345);
    for (let n = 0; n < 500; n++) {
        const len = 1 + Math.floor(rnd() * 40);
        const lines = [];
        for (let i = 0; i < len; i++) lines.push(pool[Math.floor(rnd() * pool.length)]);
        const text = lines.join("\n");
        assert.deepEqual(
            parseTimetable(text).subjects.map(legacyShape),
            legacyParse(text).map(legacyShape),
            "diverged on input:\n" + text
        );
    }
});
