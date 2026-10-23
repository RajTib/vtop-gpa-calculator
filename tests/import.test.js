const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const model = require("../js/model");
const gpa = require("../js/gpa");
const history = require("../js/history");
const storage = require("../js/storage");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "grade-history-synthetic.txt"), "utf8");

// --- helpers -------------------------------------------------------------------------------

const HEADER = ["Sl.No.", "Course Code", "Course Title", "Course Type", "Credits", "Grade",
                "Exam Month", "Result Declared", "Course Distribution", "Detail View"];
const R = (code, title, credits, grade, month, distribution = "PC") =>
    ["1", code, title, "Theory Only", String(credits), grade, month, "", distribution, "View"];
const table = rows => [HEADER].concat(rows).map(r => r.join("\t")).join("\n");
const parse = rows => history.parseGradeHistory(typeof rows === "string" ? rows : table(rows));

function applied(state, rows, opts) {
    const r = model.applyHistoryImport(state, parse(rows), opts);
    assert.equal(r.error, undefined, r.error);
    return r;
}
function ok(result) {
    assert.equal(result.error, undefined, result.error);
    return result.state;
}
// Every saved record of one course code, across all semesters.
const records = (state, code) => state.semesters.flatMap(s =>
    s.courses.filter(c => c.code === code).map(c => Object.assign({ semester: s.number }, c)));
const sem = (state, n) => model.getSemester(state, n);
const cgpa = state => gpa.computeCgpa(state.semesters);
const codes = (state, n) => sem(state, n).courses.map(c => c.code).sort();
const frozen = x => JSON.stringify(x);

const DSA = ["BCSE202L", "Data Structures", 3];
const LAB = ["BCSE202P", "Data Structures Lab", 1];
const MAT = ["BMAT201L", "Complex Variables", 4];

// A completed semester, built the way a student would: through the model's own operations.
function withCompletedCourse(state, number, code, name, credits, grade) {
    let s = state;
    if (!sem(s, number)) s = ok(model.createSemester(s, number, { status: "completed" }));
    s = ok(model.addCourses(s, number, [{ code, name, credits }]));
    const id = sem(s, number).courses.find(c => c.code === code).id;
    return ok(model.updateCourse(s, number, id, { actualGrade: grade }));
}

// --- importing a whole table ----------------------------------------------------------------

test("the synthetic table creates completed semesters 1-4 with actual grades, exam periods and no predictions", () => {
    const { state, plan } = applied(model.emptyState(), FIXTURE);
    assert.deepEqual(plan.counts, { add: 6, overwrite: 0, unchanged: 0, skip: 0, rejected: 0, superseded: 0 });
    assert.deepEqual(state.semesters.map(s => [s.number, s.status, s.kind, s.examPeriod]), [
        [1, "completed", "courses", "2024-11"], [2, "completed", "courses", "2025-04"],
        [3, "completed", "courses", "2025-11"], [4, "completed", "courses", "2026-04"],
    ]);
    assert.deepEqual(codes(state, 1), ["BHUM101L", "BMAT201L"]);
    assert.deepEqual(codes(state, 2), ["BCSE202L", "BCSE202P"]);
    const dsa = records(state, "BCSE202L")[0];
    assert.equal(dsa.actualGrade, "A");
    assert.equal(dsa.predictedGrade, null);
    assert.equal(dsa.examPeriod, "2025-04");
    assert.equal(dsa.courseType, "Theory Only");
    assert.equal(dsa.distribution, "PC");
    assert.equal(dsa.resultDeclared, "20-May-2025");
    assert.equal(state.currentSemester, null);
});

test("imported semesters feed the existing SGPA / CGPA maths", () => {
    const { state } = applied(model.emptyState(), FIXTURE);
    assert.equal(gpa.computeSemester(sem(state, 2)).display, "9.33");     // (3*9 + 1.5*10) / 4.5
    const cg = cgpa(state);
    assert.equal(cg.display, "8.80");                                      // 88 points / 10 counted credits
    assert.equal(cg.credits100, 1000);
    assert.equal(cg.status, "ok");
});

test("NGCR rows are kept with their metadata but never counted", () => {
    const { state } = applied(model.emptyState(), FIXTURE);
    const ethics = records(state, "BHUM101L")[0];
    assert.equal(ethics.name, "Ethics and Values");
    assert.equal(ethics.credits, 2, "displayed credits kept");
    assert.equal(ethics.distribution, "NGCR");
    assert.equal(ethics.reportedGrade, "P");
    assert.equal(ethics.actualGrade, null);
    assert.equal(ethics.countsToGpa, false);
    assert.equal(ethics.examPeriod, "2024-11");
    assert.equal(ethics.resultDeclared, "30-Dec-2024");
    const s1 = gpa.computeSemester(sem(state, 1));
    assert.equal(s1.credits100, 400, "only BMAT201L's 4 credits are counted");
    assert.deepEqual(s1.excluded.map(e => [e.name, e.reason]), [["Ethics and Values", "ngcr"]]);
});

test("NGCR courses with different grades and positive credits leave GPA and credit totals identical", () => {
    const base = [R(...MAT, "B", "Nov-2024", "UC")];
    const reference = cgpa(applied(model.emptyState(), base).state);
    for (const grade of ["P", "S", "A", "B", "F", "N", "W", ""]) {
        const withNgcr = applied(model.emptyState(), base.concat([R("BHUM101L", "Ethics", 2, grade, "Nov-2024", "NGCR")]));
        const cg = cgpa(withNgcr.state);
        assert.equal(cg.display, reference.display, "grade " + JSON.stringify(grade));
        assert.equal(cg.credits100, reference.credits100, "grade " + JSON.stringify(grade));
        assert.equal(cg.points100, reference.points100, "grade " + JSON.stringify(grade));
        const kept = records(withNgcr.state, "BHUM101L")[0];
        assert.equal(kept.credits, 2);
        assert.equal(kept.reportedGrade || "", grade);
        assert.equal(kept.actualGrade, null);
    }
});

test("a P grade or a non-graded name on a course that is NOT NGCR is not silently excluded (and P is reported)", () => {
    const { state, plan } = applied(model.emptyState(), [
        R(...MAT, "B", "Nov-2024", "UC"),
        R("BHUM102L", "Non-Graded Seminar", 2, "P", "Nov-2024", "UC"),
    ]);
    assert.equal(records(state, "BHUM102L").length, 0, "an unsupported grade is rejected rather than counted or hidden");
    assert.equal(plan.rejected.length, 1);
    assert.match(plan.rejected[0].reasons[0], /grade “P” is not supported/);
});

// --- semester numbering ---------------------------------------------------------------------

test("semester numbers follow exam periods, not the order of the rows", () => {
    const rows = [R(...DSA, "A", "Apr-2026"), R(...MAT, "B", "Nov-2024", "UC"), R(...LAB, "S", "Nov-2025"), R("BPHY101L", "Physics", 3, "B", "Apr-2025")];
    const forward = applied(model.emptyState(), rows).state;
    const reversed = applied(model.emptyState(), rows.slice().reverse()).state;
    const shape = s => s.semesters.map(x => [x.number, x.examPeriod, x.courses.map(c => c.code)]);
    assert.deepEqual(shape(forward), shape(reversed));
    assert.deepEqual(shape(forward), [
        [1, "2024-11", ["BMAT201L"]], [2, "2025-04", ["BPHY101L"]], [3, "2025-11", ["BCSE202P"]], [4, "2026-04", ["BCSE202L"]],
    ]);
});

test("courses sharing an exam period land in the same semester", () => {
    const { state } = applied(model.emptyState(), [R(...DSA, "A", "Nov-2024"), R(...LAB, "S", "NOV-2024"), R(...MAT, "B", "November 2024", "UC")]);
    assert.equal(state.semesters.length, 1);
    assert.deepEqual(codes(state, 1), ["BCSE202L", "BCSE202P", "BMAT201L"]);
});

test("a gap in the history stays a gap: Semesters 2 and 3 are empty slots and Apr-2026 is Semester 4", () => {
    const { state } = applied(model.emptyState(), [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "Apr-2026")]);
    assert.deepEqual(state.semesters.map(s => s.number), [1, 4]);
    assert.equal(sem(state, 2), null);
    assert.equal(sem(state, 3), null);
    assert.equal(sem(state, 4).examPeriod, "2026-04");
});

test("a later import is anchored to the exam periods already saved", () => {
    const first = applied(model.emptyState(), [R(...MAT, "B", "Nov-2024", "UC")]).state;
    // Pasting only a later period must be Semester 3, not "Semester 1 because it's the earliest in this paste".
    const { state, plan } = applied(first, [R(...DSA, "A", "Nov-2025")]);
    assert.equal(plan.anchor.source, "saved");
    assert.deepEqual(state.semesters.map(s => [s.number, s.examPeriod]), [[1, "2024-11"], [3, "2025-11"]]);
});

test("unsupported exam periods are flagged and not imported until the student picks a semester", () => {
    const rows = [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "May-2025")];
    const plan = model.planHistoryImport(model.emptyState(), parse(rows));
    const may = plan.periods.find(p => p.key === "2025-05");
    assert.equal(may.semester, null);
    assert.equal(may.status, "unassigned");
    assert.match(may.reason, /November \(odd\) or April \(even\)/);
    assert.deepEqual(plan.items.map(i => [i.code, i.action, i.kind]), [["BMAT201L", "add", "new"], ["BCSE202L", "skip", "unassigned"]]);

    const chosen = applied(model.emptyState(), rows, { periodOverrides: { "2025-05": 3 } }).state;
    assert.deepEqual(codes(chosen, 3), ["BCSE202L"]);
    assert.equal(sem(chosen, 3).examPeriod, "2025-05");
});

test("periods outside Semesters 1-8 are flagged, never clamped or wrapped", () => {
    const plan = model.planHistoryImport(model.emptyState(), parse([R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "Apr-2030")]));
    const late = plan.periods.find(p => p.key === "2030-04");
    assert.equal(late.semester, null);
    assert.match(late.reason, /outside Semesters 1-8/);
});

test("two exam periods can't be forced into one semester, and a semester holding another period is not reused", () => {
    const rows = [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "Apr-2025")];
    const clash = model.planHistoryImport(model.emptyState(), parse(rows), { periodOverrides: { "2025-04": 1 } });
    assert.equal(clash.periods.find(p => p.key === "2025-04").status, "blocked");
    assert.match(clash.periods.find(p => p.key === "2025-04").reason, /already used by Nov-2024/);

    const saved = applied(model.emptyState(), [R(...MAT, "B", "Nov-2024", "UC")]).state;
    const other = model.planHistoryImport(saved, parse([R(...DSA, "A", "Apr-2025")]), { periodOverrides: { "2025-04": 1 } });
    assert.match(other.periods[0].reason, /already holds results from Nov-2024/);
});

test("an invalid semester choice is ignored with a warning", () => {
    const plan = model.planHistoryImport(model.emptyState(), parse([R(...MAT, "B", "Nov-2024", "UC")]), { periodOverrides: { "2024-11": 12 } });
    assert.equal(plan.periods[0].semester, 1);
    assert.equal(plan.warnings.length, 1);
});

// --- retakes and grade improvements ---------------------------------------------------------

function firstAttempt() {
    return applied(model.emptyState(), [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "C", "Apr-2025"), R(...LAB, "S", "Apr-2025")]).state;
}

test("a retake overwrites the previous record: one counted record, new grade, credits counted once", () => {
    const before = firstAttempt();
    assert.equal(cgpa(before).display, "7.88");
    assert.equal(cgpa(before).credits100, 800);

    const { state, plan } = applied(before, [
        R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "C", "Apr-2025"), R(...LAB, "S", "Apr-2025"),
        R(...DSA, "A", "Nov-2025"),                                   // the retake
    ]);
    assert.deepEqual(plan.counts, { add: 0, overwrite: 1, unchanged: 2, skip: 0, rejected: 0, superseded: 1 });
    assert.equal(plan.items.find(i => i.action === "overwrite").kind, "retake");

    const dsa = records(state, "BCSE202L");
    assert.equal(dsa.length, 1, "the same course is never counted twice");
    assert.equal(dsa[0].actualGrade, "A");
    assert.equal(dsa[0].examPeriod, "2025-11");
    assert.equal(dsa[0].credits, 3);
    assert.equal(dsa[0].semester, 2, "the record stays where it was; it is updated in place");
    assert.equal(dsa[0].id, records(before, "BCSE202L")[0].id);

    const cg = cgpa(state);
    assert.equal(cg.credits100, 800, "credit total did not grow");
    assert.equal(cg.display, "8.63");                                  // C is gone from the calculation
    assert.equal(sem(state, 3), null, "no empty or duplicate semester was created for the retake's exam period");
});

test("the improvement can arrive on its own, in a later paste", () => {
    const { state } = applied(firstAttempt(), [R(...DSA, "A", "Nov-2025")]);
    assert.equal(records(state, "BCSE202L").length, 1);
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "A");
    assert.equal(cgpa(state).credits100, 800);
});

test("a retake can also lower a grade: the newer valid result wins either way", () => {
    const { state } = applied(firstAttempt(), [R(...DSA, "E", "Nov-2025")]);
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "E");
});

test("an older result never replaces a newer saved one", () => {
    const newer = applied(firstAttempt(), [R(...DSA, "A", "Nov-2025")]).state;
    const { state, plan } = applied(newer, [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "C", "Apr-2025")]);
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "A");
    const item = plan.items.find(i => i.code === "BCSE202L");
    assert.deepEqual([item.action, item.kind], ["skip", "older"]);
    assert.equal(frozen(state), frozen(newer), "nothing changed at all");
});

test("a saved record entered by hand (no exam period) is compared by its semester", () => {
    // Semester 2 holds a hand-entered C. The history says Apr-2025 (Semester 2) is the same semester, and a
    // second paste says Nov-2025 (Semester 3) is later.
    let s = withCompletedCourse(model.emptyState(), 1, "BMAT201L", "Complex Variables", 4, "B");
    s = withCompletedCourse(s, 2, "BCSE202L", "Data Structures", 3, "C");
    assert.equal(records(s, "BCSE202L")[0].examPeriod, undefined);

    const later = applied(s, [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "C", "Apr-2025"), R(...DSA, "A", "Nov-2025")]).state;
    assert.equal(records(later, "BCSE202L").length, 1);
    assert.equal(records(later, "BCSE202L")[0].actualGrade, "A");

    // The same table but with an OLDER result for a course saved in a later semester is not allowed to replace it.
    // Nov-2024 is Semester 1 here. BCSE202L is saved in Semester 2, so a Nov-2024 result is older and is not
    // allowed to replace it. BMAT201L is saved in Semester 1: same semester, so it is refreshed from the table.
    const olderPlan = model.planHistoryImport(s, parse([R(...MAT, "B", "Nov-2024", "UC"), R("BCSE202L", "Data Structures", 3, "S", "Nov-2024")]));
    const outcome = code => olderPlan.items.find(i => i.code === code);
    assert.deepEqual([outcome("BMAT201L").action, outcome("BMAT201L").kind], ["overwrite", "revised"]);
    assert.deepEqual([outcome("BCSE202L").action, outcome("BCSE202L").kind], ["skip", "older"]);
});

test("re-importing the same table is idempotent: nothing changes the second time", () => {
    const first = applied(model.emptyState(), FIXTURE);
    const second = applied(first.state, FIXTURE);
    assert.deepEqual(second.plan.counts, { add: 0, overwrite: 0, unchanged: 6, skip: 0, rejected: 0, superseded: 0 });
    assert.deepEqual(second.state, first.state);
});

test("same exam period but a different result: the saved record is updated, and it is flagged as a revision", () => {
    const saved = applied(model.emptyState(), [R(...DSA, "B", "Nov-2024")]).state;
    const { state, plan } = applied(saved, [R(...DSA, "A", "Nov-2024")]);
    assert.equal(plan.items[0].kind, "revised");
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "A");
    assert.equal(records(state, "BCSE202L").length, 1);
});

test("a course registered in an ongoing semester (a retake in progress) is not duplicated by an older result", () => {
    let s = ok(model.createSemester(model.emptyState(), 5, { status: "ongoing" }));
    s = ok(model.addCourses(s, 5, [{ code: "BCSE202L", name: "Data Structures", credits: 3 }]));
    const before = frozen(sem(s, 5));
    const { state, plan } = applied(s, [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "C", "Apr-2025")]);
    assert.deepEqual(plan.items.map(i => [i.code, i.action, i.kind]), [["BMAT201L", "add", "new"], ["BCSE202L", "skip", "pending-retake"]]);
    assert.equal(records(state, "BCSE202L").length, 1);
    assert.equal(frozen(sem(state, 5)), before, "the ongoing semester is untouched");
    assert.equal(sem(state, 2), null);
});

test("a retake keeps its predicted grade separate from the imported actual grade", () => {
    let s = ok(model.createSemester(model.emptyState(), 2, { status: "ongoing" }));
    s = ok(model.addCourses(s, 2, [{ code: "BCSE202L", name: "Data Structures", credits: 3 }]));   // predicted S
    s = ok(model.markCompleted(s, 2));
    const id = sem(s, 2).courses[0].id;
    s = ok(model.updateCourse(s, 2, id, { actualGrade: "C" }));
    assert.deepEqual([sem(s, 2).courses[0].actualGrade, sem(s, 2).courses[0].predictedGrade], ["C", "S"]);

    const { state } = applied(s, [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "Apr-2025")]);
    const c = records(state, "BCSE202L")[0];
    assert.equal(c.actualGrade, "A", "the imported grade is the actual grade");
    assert.equal(c.predictedGrade, "S", "the old prediction is not touched, and not mistaken for the result");
});

test("an import never writes a grade into predictedGrade", () => {
    const { state } = applied(model.emptyState(), FIXTURE);
    state.semesters.forEach(s => s.courses.forEach(c => assert.equal(c.predictedGrade, null, c.code)));
});

test("a student's own 'don't count' choice survives an overwrite, but NGCR can never be switched in", () => {
    let s = withCompletedCourse(model.emptyState(), 1, "BCSE202L", "Data Structures", 3, "C");
    const id = sem(s, 1).courses[0].id;
    s = ok(model.updateCourse(s, 1, id, { countsToGpa: false }));
    const { state } = applied(s, [R(...DSA, "A", "Nov-2024")]);
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "A");
    assert.equal(records(state, "BCSE202L")[0].countsToGpa, false);
});

test("a hand-entered course is matched by code, never by title alone", () => {
    const s = withCompletedCourse(model.emptyState(), 1, "BCSE999L", "Data Structures", 3, "C");   // same title, other code
    const { state } = applied(s, [R(...DSA, "A", "Nov-2024")]);
    assert.equal(records(state, "BCSE999L").length, 1);
    assert.equal(records(state, "BCSE202L").length, 1, "a different code is a different course");
    assert.equal(records(state, "BCSE999L")[0].actualGrade, "C");
});

test("a course saved without a code can't be matched, so it is not overwritten", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed" }));
    s = ok(model.addCourses(s, 1, [{ code: "", name: "Data Structures", credits: 3 }]));
    const { state } = applied(s, [R(...DSA, "A", "Nov-2024")]);
    assert.equal(sem(state, 1).courses.length, 2);
});

test("a course already saved more than once is reported, and only the latest record is updated", () => {
    let s = withCompletedCourse(model.emptyState(), 1, "BCSE202L", "Data Structures", 3, "C");
    s = withCompletedCourse(s, 2, "BCSE202L", "Data Structures", 3, "D");
    const { state, plan } = applied(s, [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "Nov-2025")]);
    assert.ok(plan.warnings.some(w => /saved 2 times/.test(w)));
    assert.equal(sem(state, 1).courses.find(c => c.code === "BCSE202L").actualGrade, "C");
    assert.equal(sem(state, 2).courses.find(c => c.code === "BCSE202L").actualGrade, "A");
});

// --- duplicates inside one import ----------------------------------------------------------

test("a course that appears twice in the table is imported once, from its latest exam period", () => {
    const { state, plan } = applied(model.emptyState(), [
        R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "F", "Nov-2024"), R(...DSA, "A", "Apr-2025"),
    ]);
    assert.equal(records(state, "BCSE202L").length, 1);
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "A");
    assert.equal(records(state, "BCSE202L")[0].semester, 2);
    assert.deepEqual(plan.superseded.map(x => [x.code, x.kind, x.dropped.grade, x.kept.grade]), [["BCSE202L", "older", "F", "A"]]);
    assert.equal(cgpa(state).credits100, 700, "3 + 4 credits, the failed attempt is not also counted");
    assert.equal(cgpa(state).failedCredits100, 0);
});

test("the order of the duplicate rows does not change the outcome", () => {
    const rows = [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "F", "Nov-2024"), R(...DSA, "A", "Apr-2025")];
    const a = applied(model.emptyState(), rows).state;
    const b = applied(model.emptyState(), [rows[2], rows[1], rows[0]]).state;
    assert.equal(records(a, "BCSE202L")[0].actualGrade, records(b, "BCSE202L")[0].actualGrade);
    assert.equal(records(a, "BCSE202L")[0].semester, records(b, "BCSE202L")[0].semester);
});

test("identical repeated rows are collapsed as duplicates and do not inflate credits", () => {
    const { state, plan } = applied(model.emptyState(), [R(...DSA, "A", "Nov-2024"), R(...DSA, "A", "Nov-2024"), R(...DSA, "A", "Nov-2024")]);
    assert.equal(records(state, "BCSE202L").length, 1);
    assert.deepEqual(plan.superseded.map(x => x.kind), ["duplicate", "duplicate"]);
    assert.deepEqual(plan.conflicts, []);
    assert.equal(cgpa(state).credits100, 300);
    assert.equal(cgpa(state).display, "9.00");
});

test("the same exam period with different grades is a reported conflict, resolved the same way every time", () => {
    const rows = [R(...DSA, "B", "Nov-2024"), R(...DSA, "A", "Nov-2024")];
    const first = applied(model.emptyState(), rows);
    assert.equal(first.plan.conflicts.length, 1);
    assert.equal(first.plan.conflicts[0].kept.grade, "A", "the later line wins");
    assert.equal(first.plan.conflicts[0].dropped.grade, "B");
    assert.equal(records(first.state, "BCSE202L")[0].actualGrade, "A");

    const swapped = applied(model.emptyState(), rows.slice().reverse());
    assert.equal(swapped.plan.conflicts.length, 1);
    assert.equal(records(swapped.state, "BCSE202L")[0].actualGrade, "B");
});

// --- unusable rows ------------------------------------------------------------------------------

test("invalid and incomplete rows are reported with reasons; the good rows still import", () => {
    const { state, plan } = applied(model.emptyState(), [
        R(...MAT, "B", "Nov-2024", "UC"),
        R("BCHY101L", "Chemistry", 3, "", "Nov-2024"),                 // no grade
        R("BPHY101L", "Physics", 3, "N", "Nov-2024"),                  // unsupported grade
        R("BENG101L", "English", "", "B", "Nov-2024"),                 // no credits (parser)
        R("BENG102L", "English 2", 3, "B", "Foo-2024"),                // bad exam month (parser)
        R("???", "Mystery", 3, "B", "Nov-2024"),                       // bad code (parser)
    ]);
    assert.deepEqual(codes(state, 1), ["BMAT201L"]);
    assert.equal(plan.rejected.length, 5);
    assert.equal(plan.counts.rejected, 5);
    const reasons = plan.rejected.map(r => r.reasons.join("; "));
    assert.ok(reasons.some(r => /grade is missing/.test(r)));
    assert.ok(reasons.some(r => /grade “N” is not supported/.test(r)));
    assert.ok(reasons.some(r => /credits are missing/.test(r)));
    assert.ok(reasons.some(r => /not recognised/.test(r)));
    plan.rejected.forEach(r => assert.ok(r.line > 1 && r.text));
});

test("a newer attempt that could not be read warns that an older result was used", () => {
    const { state, plan } = applied(model.emptyState(), [R(...DSA, "F", "Nov-2024"), R(...DSA, "N", "Apr-2025")]);
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "F");
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /newer than the result used/);
    assert.match(plan.warnings[0], /could not be read/);
});

test("a table with no header, or no usable rows, changes nothing and says why", () => {
    const s = firstAttempt();
    const before = frozen(s);
    for (const text of ["", "hello", "BCSE202L\tData Structures\t3\tA\tNov-2024"]) {
        const r = model.applyHistoryImport(s, history.parseGradeHistory(text));
        assert.ok(r.error, JSON.stringify(text));
        assert.equal(frozen(s), before);
    }
    const none = model.planHistoryImport(s, parse([R("???", "Mystery", 3, "B", "Nov-2024")]));
    assert.equal(none.importable, false);
    assert.equal(none.counts.rejected, 1);
});

test("garbage passed in place of a parsed table is an error, not an exception", () => {
    for (const bad of [null, undefined, {}, "text", 42, { headerFound: false, error: "nope" }]) {
        const r = model.applyHistoryImport(model.emptyState(), bad);
        assert.ok(r.error, JSON.stringify(bad));
    }
});

test("the state passed in is never mutated, on success or failure", () => {
    const s = firstAttempt();
    const before = frozen(s);
    applied(s, [R(...DSA, "A", "Nov-2025")]);
    model.applyHistoryImport(s, history.parseGradeHistory("nonsense"));
    model.planHistoryImport(s, parse([R(...DSA, "A", "Nov-2025")]));
    assert.equal(frozen(s), before);
});

// --- other student data is left alone ----------------------------------------------------------

test("summary-only semesters keep working and are never overwritten", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed", kind: "summary" }));
    s = ok(model.setSummary(s, 1, { credits: 20, sgpa: 8.5 }));
    const summaryBefore = frozen(sem(s, 1));

    // Apr-2025 / Nov-2025 are Semesters 2 and 3: they import next to the summary semester.
    const { state } = applied(s, [R(...DSA, "A", "Apr-2025"), R(...MAT, "B", "Nov-2025", "UC")]);
    assert.equal(frozen(sem(state, 1)), summaryBefore);
    assert.equal(cgpa(state).display, "8.48");
    assert.equal(cgpa(state).summaryOnlyCount, 1);
    assert.equal(cgpa(state).credits100, 2700);
});

test("a period that needs a summary-only semester's number is blocked, not written over it", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed", kind: "summary" }));
    s = ok(model.setSummary(s, 1, { credits: 20, sgpa: 8.5 }));
    const { state, plan } = applied(s, [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "A", "Apr-2025")]);
    const blocked = plan.items.find(i => i.code === "BMAT201L");
    assert.deepEqual([blocked.action, blocked.kind], ["skip", "blocked"]);
    assert.match(blocked.reason, /SGPA summary/);
    assert.equal(sem(state, 1).kind, "summary");
    assert.deepEqual(codes(state, 2), ["BCSE202L"]);
});

test("an ongoing semester is never overwritten; moving it is an explicit option", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "ongoing" }));
    s = ok(model.addCourses(s, 1, [{ code: "BXXX100L", name: "Current Course", credits: 3 }]));
    const ongoingBefore = frozen(sem(s, 1));

    const plain = applied(s, FIXTURE);
    assert.equal(frozen(sem(plain.state, 1)), ongoingBefore, "still the same ongoing semester");
    assert.equal(plain.state.currentSemester, 1);
    assert.deepEqual(plain.plan.items.filter(i => i.kind === "blocked").map(i => i.code).sort(), ["BHUM101L", "BMAT201L"]);
    assert.deepEqual(plain.plan.ongoingMoves, [{ from: 1, to: 5, applied: false }]);
    assert.match(plain.plan.periods[0].reason, /Move it to Semester 5/);
    assert.deepEqual(plain.state.semesters.map(x => x.number), [1, 2, 3, 4]);

    const moved = applied(s, FIXTURE, { moveOngoing: true });
    assert.deepEqual(moved.state.semesters.map(x => [x.number, x.status]),
        [[1, "completed"], [2, "completed"], [3, "completed"], [4, "completed"], [5, "ongoing"]]);
    assert.equal(moved.state.currentSemester, 5);
    assert.deepEqual(sem(moved.state, 5).courses.map(c => c.code), ["BXXX100L"]);
    assert.equal(sem(moved.state, 5).courses[0].predictedGrade, "S", "its predictions came along unchanged");
    assert.deepEqual(codes(moved.state, 1), ["BHUM101L", "BMAT201L"]);
});

test("moveSemester: only an ongoing semester, only to a free valid number", () => {
    let s = ok(model.createSemester(model.emptyState(), 2, { status: "ongoing" }));
    s = ok(model.createSemester(s, 3, { status: "completed" }));
    assert.equal(ok(model.moveSemester(s, 2, 6)).currentSemester, 6);
    assert.deepEqual(ok(model.moveSemester(s, 2, 6)).semesters.map(x => x.number), [3, 6]);
    assert.match(model.moveSemester(s, 3, 5).error, /ongoing/);
    assert.match(model.moveSemester(s, 2, 3).error, /already exists/);
    assert.ok(model.moveSemester(s, 2, 9).error);
    assert.ok(model.moveSemester(s, 7, 8).error);
});

test("with no free semester to move an ongoing semester to, the conflict stays blocked", () => {
    let s = model.emptyState();
    for (let n = 2; n <= 8; n++) s = ok(model.createSemester(s, n, { status: "completed" }));
    s = ok(model.createSemester(s, 1, { status: "ongoing" }));
    const plan = model.planHistoryImport(s, parse([R(...MAT, "B", "Nov-2024", "UC")]), { moveOngoing: true });
    assert.deepEqual(plan.ongoingMoves, []);
    assert.equal(plan.periods[0].status, "blocked");
    assert.match(plan.periods[0].reason, /no free semester/);
});

test("importing leaves unrelated semesters and the current semester exactly as they were", () => {
    let s = ok(model.createSemester(model.emptyState(), 6, { status: "ongoing" }));
    s = ok(model.addCourses(s, 6, [{ code: "BXXX600L", name: "Now", credits: 3 }]));
    const ongoingBefore = frozen(sem(s, 6));
    const { state } = applied(s, FIXTURE);
    assert.equal(frozen(sem(state, 6)), ongoingBefore);
    assert.equal(state.currentSemester, 6);
});

test("a semester that is full does not take more courses than the limit", () => {
    const rows = [];
    for (let i = 0; i < model.MAX_COURSES + 2; i++) rows.push(R("BTST" + String(100 + i), "Test " + i, 1, "A", "Nov-2024"));
    const { state, plan } = applied(model.emptyState(), rows);
    assert.equal(sem(state, 1).courses.length, model.MAX_COURSES);
    assert.equal(plan.items.filter(i => i.kind === "full").length, 2);
});

// --- storage failures and old data ---------------------------------------------------------------

function fakeStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    const api = {
        data, failWrites: false,
        getItem: k => (data.has(k) ? data.get(k) : null),
        setItem(k, v) {
            if (api.failWrites) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
            data.set(k, String(v));
        },
        removeItem: k => data.delete(k),
        key: i => [...data.keys()][i],
        get length() { return data.size; },
    };
    return api;
}

test("if saving fails after an import, the data already in storage is untouched and still loads", () => {
    const saved = firstAttempt();
    const fake = fakeStorage({ [storage.KEY]: JSON.stringify(saved) });
    const rawBefore = fake.data.get(storage.KEY);

    const store = storage.createStore(() => fake);
    const loaded = store.load();
    assert.equal(loaded.status, "ok");
    const result = applied(loaded.state, [R(...DSA, "A", "Nov-2025")]);

    fake.failWrites = true;
    assert.deepEqual(store.save(result.state), { ok: false, reason: "quota" });
    assert.equal(fake.data.get(storage.KEY), rawBefore, "storage still holds the previous data, byte for byte");

    const reloaded = storage.createStore(() => fake).load();
    assert.equal(reloaded.status, "ok");
    assert.deepEqual(reloaded.state, saved);

    fake.failWrites = false;
    assert.deepEqual(store.save(result.state), { ok: true });
    assert.equal(records(storage.createStore(() => fake).load().state, "BCSE202L")[0].actualGrade, "A");
});

test("with storage unavailable the import still computes, and saving reports it instead of throwing", () => {
    const store = storage.createStore(() => { throw new Error("blocked"); });
    assert.equal(store.load().status, "unavailable");
    const result = applied(model.emptyState(), FIXTURE);
    assert.deepEqual(store.save(result.state), { ok: false, reason: "unavailable" });
    assert.equal(cgpa(result.state).display, "8.80");
});

test("an imported profile survives export, backup import and storage round trips", () => {
    const { state } = applied(model.emptyState(), FIXTURE);
    const viaBackup = storage.parseImport(storage.buildExport(state));
    assert.equal(viaBackup.ok, true);
    assert.deepEqual(viaBackup.state, state);
    const fake = fakeStorage();
    const store = storage.createStore(() => fake);
    assert.deepEqual(store.save(state), { ok: true });
    assert.deepEqual(storage.createStore(() => fake).load().state, state);
});

test("data saved by earlier versions (no new fields) still validates, unchanged and without gaining fields", () => {
    const old = {
        schemaVersion: 1, currentSemester: 3,
        semesters: [
            { number: 1, status: "completed", kind: "summary", courses: [], summary: { credits: 20, sgpa: 8.5 } },
            { number: 2, status: "completed", kind: "courses", summary: { credits: null, sgpa: null }, courses: [
                { id: "c1", code: "BCSE202L", name: "Data Structures", credits: 3, countsToGpa: true, actualGrade: "A", predictedGrade: null }] },
            { number: 3, status: "ongoing", kind: "courses", summary: { credits: null, sgpa: null }, courses: [
                { id: "c2", code: "", name: "Hand Added", credits: null, countsToGpa: false, actualGrade: null, predictedGrade: "S" }] },
        ],
    };
    const v = model.validateState(JSON.parse(JSON.stringify(old)));
    assert.equal(v.ok, true, v.errors && v.errors.join());
    assert.deepEqual(v.state, old);
    for (const s of v.state.semesters) {
        assert.equal("examPeriod" in s, false);
        s.courses.forEach(c => ["distribution", "courseType", "reportedGrade", "examPeriod", "resultDeclared"].forEach(k => assert.equal(k in c, false, k)));
    }
    // and the app can import history on top of it
    const { state } = applied(v.state, [R("BMAT201L", "Complex Variables", 4, "B", "Nov-2024", "UC")]);
    assert.equal(sem(state, 3).status, "ongoing");
    assert.equal(state.currentSemester, 3);
});

test("new optional fields are validated: bad types and periods are rejected", () => {
    const base = () => ({ schemaVersion: 1, currentSemester: null, semesters: [{ number: 1, status: "completed", kind: "courses", summary: {}, courses: [
        { id: "c1", code: "A", name: "A", credits: 1, countsToGpa: true, actualGrade: "A", predictedGrade: null }] }] });
    for (const [mutate, pattern] of [
        [s => { s.semesters[0].courses[0].examPeriod = "2025-13"; }, /exam period/],
        [s => { s.semesters[0].courses[0].examPeriod = 202504; }, /exam period/],
        [s => { s.semesters[0].examPeriod = "April"; }, /exam period/],
        [s => { s.semesters[0].courses[0].distribution = 5; }, /distribution must be text/],
        [s => { s.semesters[0].courses[0].reportedGrade = {}; }, /reportedGrade must be text/],
    ]) {
        const s = base(); mutate(s);
        const v = model.validateState(s);
        assert.equal(v.ok, false);
        assert.match(v.errors.join(), pattern);
    }
});

test("a stored NGCR course can't be made to count by editing the data: it is forced out and grade-free", () => {
    const s = { schemaVersion: 1, currentSemester: null, semesters: [{ number: 1, status: "completed", kind: "courses", summary: {}, courses: [
        { id: "c1", code: "BHUM101L", name: "Ethics", credits: 2, countsToGpa: true, actualGrade: "S", predictedGrade: "S", distribution: "ngcr" },
        { id: "c2", code: "BMAT201L", name: "Calculus", credits: 4, countsToGpa: true, actualGrade: "B", predictedGrade: null }] }] };
    const v = model.validateState(s);
    assert.equal(v.ok, true);
    const ngcr = v.state.semesters[0].courses[0];
    assert.deepEqual([ngcr.distribution, ngcr.countsToGpa, ngcr.actualGrade, ngcr.predictedGrade], ["NGCR", false, null, null]);
    assert.equal(cgpa(v.state).credits100, 400);
});

test("editing an NGCR course by hand can't turn it into a counted or graded course", () => {
    const { state } = applied(model.emptyState(), FIXTURE);
    const c = records(state, "BHUM101L")[0];
    assert.match(model.updateCourse(state, 1, c.id, { countsToGpa: true }).error, /NGCR/);
    assert.match(model.updateCourse(state, 1, c.id, { actualGrade: "S" }).error, /NGCR/);
    assert.match(model.updateCourse(state, 1, c.id, { predictedGrade: "S" }).error, /NGCR/);
    const renamed = ok(model.updateCourse(state, 1, c.id, { name: "Ethics & Values", credits: 3 }));
    const after = records(renamed, "BHUM101L")[0];
    assert.equal(after.name, "Ethics & Values");
    assert.equal(after.distribution, "NGCR");
    assert.equal(after.reportedGrade, "P");
    assert.equal(cgpa(renamed).credits100, cgpa(state).credits100);
});

test("reopening and completing semesters leaves NGCR courses out and keeps their metadata", () => {
    const { state } = applied(model.emptyState(), FIXTURE);
    const reopened = ok(model.reopenSemester(state, 1));
    const c = records(reopened, "BHUM101L")[0];
    assert.equal(c.predictedGrade, null);
    assert.equal(gpa.computeSemester(sem(reopened, 1)).credits100, 400);
    const again = ok(model.markCompleted(reopened, 1));
    assert.equal(records(again, "BHUM101L")[0].reportedGrade, "P");
});

test("a period the student chooses to skip is left out entirely, even for courses already saved", () => {
    const saved = firstAttempt();
    const rows = [R(...MAT, "B", "Nov-2024", "UC"), R(...DSA, "C", "Apr-2025"), R(...DSA, "A", "Nov-2025"), R("BPHY101L", "Physics", 3, "B", "Nov-2025")];
    const { state, plan } = applied(saved, rows, { periodOverrides: { "2025-11": "none" } });
    assert.equal(plan.periods.find(p => p.key === "2025-11").status, "skipped");
    assert.equal(records(state, "BCSE202L")[0].actualGrade, "C", "the saved C is kept");
    assert.equal(records(state, "BPHY101L").length, 0, "nothing new was added from the skipped period");
    assert.deepEqual(plan.items.filter(i => i.kind === "skipped").map(i => i.code).sort(), ["BCSE202L", "BPHY101L"]);
    assert.equal(sem(state, 3), null);
});
