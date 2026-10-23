const test = require("node:test");
const assert = require("node:assert/strict");

const gpa = require("../js/gpa");

// Original main.js grade table and formula, kept here as the reference.
const LEGACY_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };
function legacyGpa(rows) {
    let totalCredits = 0, totalPoints = 0;
    rows.forEach(r => { totalCredits += r.credit; totalPoints += r.credit * LEGACY_POINTS[r.grade]; });
    return (totalPoints / totalCredits).toFixed(2);
}

let n = 0;
const course = (credits, grade, extra) =>
    Object.assign({ id: "c" + (++n), name: "Course " + n, credits, countsToGpa: true,
                    actualGrade: grade, predictedGrade: grade }, extra);
const sem = (number, status, courses) => ({ number, status, kind: "courses", courses });

test("grade-point table matches the original", () => {
    assert.deepEqual(gpa.GRADE_POINTS, LEGACY_POINTS);
    assert.deepEqual(gpa.GRADES, ["S", "A", "B", "C", "D", "E", "F"]);
});

test("SGPA matches the original formula on random inputs (ties may legitimately differ)", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const creditOptions = [0.5, 1, 1.5, 2, 3, 4];
    let compared = 0, ties = 0;

    for (let i = 0; i < 2000; i++) {
        const rows = [];
        const count = 1 + Math.floor(rnd() * 8);
        for (let j = 0; j < count; j++) {
            rows.push({
                credit: creditOptions[Math.floor(rnd() * creditOptions.length)],
                grade: gpa.GRADES[Math.floor(rnd() * gpa.GRADES.length)],
            });
        }
        const mine = gpa.evaluateCourses(rows.map(r => course(r.credit, r.grade)), "actualGrade", "actual").display;
        const old = legacyGpa(rows);
        if (mine !== old) {
            // Only allowed when the exact value sits on a rounding tie (x.xx5), where the old
            // float toFixed() is arbitrary and the new code deterministically rounds half up.
            // Exact integer arithmetic: gpa * 1000 = 10 * sum(c100 * gp) / sum(c100) * 100 / 100
            const num = rows.reduce((s, r) => s + Math.round(r.credit * 100) * LEGACY_POINTS[r.grade], 0) * 1000;
            const den = rows.reduce((s, r) => s + Math.round(r.credit * 100), 0);
            const isTie = num % den === 0 && (num / den) % 10 === 5;
            assert.ok(isTie, `mismatch not on a tie: mine=${mine} old=${old}`);
            assert.equal(mine, (Math.floor(num / den / 10) / 100 + 0.01).toFixed(2), "tie must round up");
            ties++;
        }
        compared++;
    }
    assert.equal(compared, 2000);
});

test("SGPA with different credit totals is credit-weighted", () => {
    // 4 credits of S (10) and 1 credit of F (0): (40 + 0) / 5 = 8.00, not (10 + 0) / 2 = 5.00
    const r = gpa.evaluateCourses([course(4, "S"), course(1, "F")], "actualGrade", "actual");
    assert.equal(r.display, "8.00");
    assert.equal(r.credits100, 500);
});

test("F counts in the denominator and is tracked as failed credits", () => {
    const r = gpa.evaluateCourses([course(3, "A"), course(3, "F")], "actualGrade", "actual");
    assert.equal(r.display, "4.50");
    assert.equal(r.failedCredits100, 300);
});

test("courses that do not count toward GPA are excluded and reported", () => {
    const r = gpa.evaluateCourses(
        [course(3, "S"), course(2, "F", { countsToGpa: false, name: "Ethics" })],
        "actualGrade", "actual");
    assert.equal(r.display, "10.00");
    assert.equal(r.credits100, 300);
    assert.deepEqual(r.excluded.map(e => [e.name, e.reason]), [["Ethics", "non-gpa"]]);
    assert.equal(r.status, "ok");
});

test("missing credit and missing grade are explicit, never guessed", () => {
    const r = gpa.evaluateCourses([
        course(3, "A"),
        course(null, "S", { name: "No credit" }),
        course(2, null, { name: "No grade" }),
    ], "actualGrade", "actual");
    assert.equal(r.status, "incomplete");
    assert.equal(r.display, "9.00");
    assert.deepEqual(r.excluded.map(e => e.reason).sort(), ["no-credit", "no-grade"]);
});

test("invalid credits (negative, NaN, string, >2 decimals, absurd) are treated as missing", () => {
    for (const bad of [-1, NaN, "3", 1.005, 41, Infinity, undefined]) {
        const r = gpa.evaluateCourses([course(bad, "S")], "actualGrade", "actual");
        assert.equal(r.status, "incomplete", String(bad));
        assert.equal(r.gpa100, null);
    }
});

test("unknown grade strings (including prototype keys) do not count", () => {
    for (const bad of ["Z", "", "toString", "__proto__", "s", 10]) {
        const r = gpa.evaluateCourses([course(3, bad)], "actualGrade", "actual");
        assert.equal(r.status, "incomplete", String(bad));
    }
});

test("zero-credit courses are excluded without making the result incomplete", () => {
    const r = gpa.evaluateCourses([course(3, "A"), course(0, "S")], "actualGrade", "actual");
    assert.equal(r.status, "ok");
    assert.equal(r.display, "9.00");
});

test("no countable courses -> empty, no NaN", () => {
    const r = gpa.evaluateCourses([], "actualGrade", "actual");
    assert.equal(r.status, "empty");
    assert.equal(r.gpa100, null);
    assert.equal(r.display, "—");
});

test("rounding is deterministic half-up on exact values", () => {
    // (3*10 + 3*9 + 2*8) / 8 = 9.125 -> 9.13
    const r = gpa.evaluateCourses([course(3, "S"), course(3, "A"), course(2, "B")], "actualGrade", "actual");
    assert.equal(r.display, "9.13");
    // (2*10 + 1*9) / 3 = 9.666.. -> 9.67
    assert.equal(gpa.evaluateCourses([course(2, "S"), course(1, "A")], "actualGrade", "actual").display, "9.67");
    // fractional credits: (1.5*9 + 0.5*5) / 2 = 8.00 exactly
    assert.equal(gpa.evaluateCourses([course(1.5, "A"), course(0.5, "E")], "actualGrade", "actual").display, "8.00");
});

test("completed semester uses actual grades; ongoing uses predicted grades", () => {
    const c = course(4, "S", { actualGrade: "B", predictedGrade: "S" });
    const done = gpa.computeSemester(sem(1, "completed", [c]));
    const ongoing = gpa.computeSemester(sem(1, "ongoing", [c]));
    assert.equal(done.basis, "actual");
    assert.equal(done.display, "8.00");
    assert.equal(ongoing.basis, "projected");
    assert.equal(ongoing.display, "10.00");
});

test("CGPA is credit-weighted across completed semesters, not an average of SGPAs", () => {
    const s1 = sem(1, "completed", [course(20, "S")]);               // SGPA 10.00 over 20 credits
    const s2 = sem(2, "completed", [course(4, "E")]);                // SGPA 5.00 over 4 credits
    const cg = gpa.computeCgpa([s1, s2]);
    assert.equal(cg.display, "9.17");                                // (200 + 20) / 24 = 9.1666..
    assert.notEqual(cg.display, "7.50");                             // naive mean of SGPAs
    assert.equal(cg.credits100, 2400);
    assert.deepEqual(cg.semesters, [1, 2]);
    assert.equal(cg.basis, "actual");
});

test("ongoing predictions never change the actual CGPA", () => {
    const done = sem(1, "completed", [course(4, "B")]);
    const ongoing = sem(2, "ongoing", [course(4, "S")]);
    const before = gpa.computeCgpa([done]);
    const after = gpa.computeCgpa([done, ongoing]);
    assert.deepEqual(after, before);
    assert.equal(after.display, "8.00");

    const projected = gpa.computeCgpa([done, ongoing], { includeOngoing: true });
    assert.equal(projected.basis, "projected");
    assert.equal(projected.display, "9.00");
});

test("changing a predicted grade does not alter a completed semester", () => {
    const done = sem(1, "completed", [course(4, "B")]);
    const ongoing = sem(2, "ongoing", [course(4, "S")]);
    const snapshot = JSON.stringify(gpa.computeSemester(done));
    ongoing.courses[0].predictedGrade = "F";
    assert.equal(JSON.stringify(gpa.computeSemester(done)), snapshot);
    assert.equal(gpa.computeSemester(ongoing).display, "0.00");
});

test("editing a completed grade recalculates SGPA and CGPA", () => {
    const a = course(4, "B");
    const done = sem(1, "completed", [a]);
    assert.equal(gpa.computeCgpa([done]).display, "8.00");
    a.actualGrade = "S";
    assert.equal(gpa.computeSemester(done).display, "10.00");
    assert.equal(gpa.computeCgpa([done]).display, "10.00");
});

test("an incomplete completed semester flags the CGPA as incomplete", () => {
    const done = sem(1, "completed", [course(4, "B"), course(3, null)]);
    const cg = gpa.computeCgpa([done]);
    assert.equal(cg.status, "incomplete");
    assert.deepEqual(cg.incompleteSemesters, [1]);
    assert.equal(cg.display, "8.00");
});

test("summary-only semester contributes by credit weight and is flagged", () => {
    const summary = { number: 1, status: "completed", kind: "summary", summary: { credits: 20, sgpa: 8.5 } };
    const detailed = sem(2, "completed", [course(20, "S")]);
    const cg = gpa.computeCgpa([summary, detailed]);
    assert.equal(cg.display, "9.25");
    assert.equal(cg.summaryOnlyCount, 1);
    assert.equal(gpa.computeSemester(summary).display, "8.50");
});

test("malformed summary values give an incomplete, non-throwing result", () => {
    for (const s of [{}, { credits: 20 }, { sgpa: 8 }, { credits: 20, sgpa: 11 }, { credits: -2, sgpa: 8 }, { credits: 0, sgpa: 8 }]) {
        const r = gpa.computeSemester({ number: 1, status: "completed", kind: "summary", summary: s });
        assert.equal(r.status, "incomplete");
        assert.equal(r.gpa100, null);
    }
});

// --- NGCR: kept in history, never part of any GPA or credit total --------------------------
const ngcr = (credits, grade, extra) =>
    course(credits, null, Object.assign({ distribution: "NGCR", countsToGpa: false, reportedGrade: grade }, extra));

test("NGCR courses with any displayed grade and positive credits change neither SGPA nor credits", () => {
    const graded = [course(4, "A"), course(3, "B")];
    const base = gpa.computeSemester(sem(1, "completed", graded));
    for (const grade of ["P", "S", "A", "F", "N", "", null]) {
        const r = gpa.computeSemester(sem(1, "completed", graded.concat(ngcr(2, grade))));
        assert.equal(r.gpa100, base.gpa100, String(grade));
        assert.equal(r.credits100, base.credits100, String(grade));
        assert.equal(r.points100, base.points100, String(grade));
        assert.equal(r.failedCredits100, base.failedCredits100, String(grade));
        assert.ok(r.excluded.some(e => e.reason === "ngcr"), String(grade));
    }
});

test("an NGCR course cannot be switched back in: the distribution wins over countsToGpa and grades", () => {
    const sneaky = course(3, "S", { distribution: "NGCR", countsToGpa: true, name: "Sneaky NGCR" });
    const r = gpa.evaluateCourses([course(4, "B"), sneaky], "actualGrade", "actual");
    assert.equal(r.display, "8.00");
    assert.equal(r.credits100, 400);
    assert.deepEqual(r.excluded.map(e => [e.name, e.reason]), [["Sneaky NGCR", "ngcr"]]);
    const projected = gpa.evaluateCourses([course(4, "B"), sneaky], "predictedGrade", "projected");
    assert.equal(projected.display, "8.00");
});

test("an NGCR course with no credit or grade does not make the semester incomplete", () => {
    const r = gpa.computeSemester(sem(1, "completed", [course(4, "B"), ngcr(null, null)]));
    assert.equal(r.status, "ok");
});

test("a semester of only NGCR courses is empty, and contributes nothing to CGPA", () => {
    const only = sem(1, "completed", [ngcr(2, "P"), ngcr(1, "P")]);
    assert.equal(gpa.computeSemester(only).status, "empty");
    const cg = gpa.computeCgpa([only, sem(2, "completed", [course(4, "A")])]);
    assert.equal(cg.display, "9.00");
    assert.equal(cg.credits100, 400);
    assert.deepEqual(cg.semesters, [2]);
});

test("NGCR is recognised by distribution only: a P grade or a 'non-graded' name alone is not enough", () => {
    assert.equal(gpa.isNgcr({ distribution: "NGCR" }), true);
    for (const c of [{}, { distribution: "" }, { distribution: "PC" }, { distribution: "ngcr" }, { reportedGrade: "P" },
                     { name: "Non-graded Core Requirement" }, { actualGrade: null, credits: 2 }, null, undefined]) {
        assert.equal(gpa.isNgcr(c), false, JSON.stringify(c));
    }
});

test("NGCR in a projected CGPA is excluded as well", () => {
    const ongoing = sem(2, "ongoing", [course(4, "S"), ngcr(2, "P")]);
    const cg = gpa.computeCgpa([sem(1, "completed", [course(4, "B")]), ongoing], { includeOngoing: true });
    assert.equal(cg.display, "9.00");
    assert.equal(cg.credits100, 800);
});

test("formatting helpers", () => {
    assert.equal(gpa.formatGpa(842), "8.42");
    assert.equal(gpa.formatGpa(805), "8.05");
    assert.equal(gpa.formatGpa(1000), "10.00");
    assert.equal(gpa.formatGpa(0), "0.00");
    assert.equal(gpa.formatCredits(150), "1.5");
    assert.equal(gpa.formatCredits(300), "3");
    assert.equal(gpa.formatPoints(3 * 100 * 9 * 100), "27");
});
