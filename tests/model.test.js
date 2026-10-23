const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const model = require("../js/model");
const gpa = require("../js/gpa");
const { parseTimetable } = require("../js/parser");

const SAMPLE = fs.readFileSync(path.join(__dirname, "fixtures", "timetable-synthetic.txt"), "utf8");

const asIncoming = subjects => subjects.map(s => ({
    code: s.code, name: s.course, credits: s.creditMissing ? null : s.credit,
}));

function ok(result) {
    assert.equal(result.error, undefined, result.error);
    return result.state;
}

function ongoingWithSample(number = 3) {
    let s = ok(model.createSemester(model.emptyState(), number, { status: "ongoing" }));
    s = ok(model.addCourses(s, number, asIncoming(parseTimetable(SAMPLE).subjects)));
    return s;
}

test("createSemester: first ongoing semester becomes current; duplicates and bad numbers are rejected", () => {
    let s = ok(model.createSemester(model.emptyState(), 3, { status: "ongoing" }));
    assert.equal(s.currentSemester, 3);
    s = ok(model.createSemester(s, 1, { status: "completed" }));
    assert.equal(s.currentSemester, 3);
    assert.deepEqual(s.semesters.map(x => x.number), [1, 3]);

    assert.match(model.createSemester(s, 3).error, /already exists/);
    for (const bad of [0, 9, 1.5, "2", null, NaN]) {
        assert.ok(model.createSemester(s, bad).error, String(bad));
    }
    assert.match(model.createSemester(s, 2, { status: "ongoing", kind: "summary" }).error, /must be completed/);
});

test("operations never mutate the state they were given", () => {
    const s0 = ongoingWithSample();
    const frozen = JSON.stringify(s0);
    const id = s0.semesters[0].courses[0].id;
    model.updateCourse(s0, 3, id, { name: "Changed" });
    model.removeCourse(s0, 3, id);
    model.markCompleted(s0, 3);
    model.addBlankCourse(s0, 3);
    model.deleteSemester(s0, 3);
    assert.equal(JSON.stringify(s0), frozen);
});

test("importing the sample timetable creates ongoing courses with predicted grade S and no actual grade", () => {
    const s = ongoingWithSample();
    const sem = model.getSemester(s, 3);
    assert.equal(sem.courses.length, 5);
    for (const c of sem.courses) {
        assert.equal(c.predictedGrade, "S");
        assert.equal(c.actualGrade, null);
        assert.equal(c.countsToGpa, true);
    }
});

test("a missing credit is stored as null, not as 0", () => {
    let s = ok(model.createSemester(model.emptyState(), 1));
    const text = "BCSE101L - Mystery\nProgramme Core\nRegistered and Approved";
    s = ok(model.addCourses(s, 1, asIncoming(parseTimetable(text).subjects)));
    assert.equal(model.getSemester(s, 1).courses[0].credits, null);
    assert.equal(gpa.computeSemester(model.getSemester(s, 1)).status, "incomplete");
});

test("pasting the same timetable twice does not duplicate courses", () => {
    const s1 = ongoingWithSample();
    const again = model.addCourses(s1, 3, asIncoming(parseTimetable(SAMPLE).subjects));
    assert.equal(again.added.length, 0);
    assert.equal(again.duplicates.length, 5);
    assert.equal(model.getSemester(again.state, 3).courses.length, 5);
});

test("re-importing never overwrites a course the student already edited", () => {
    let s = ongoingWithSample();
    const target = model.getSemester(s, 3).courses.find(c => c.code === "BCSE202L");
    s = ok(model.updateCourse(s, 3, target.id, { predictedGrade: "C", credits: 3.5 }));
    const again = ok(model.addCourses(s, 3, asIncoming(parseTimetable(SAMPLE).subjects)));
    const after = model.getSemester(again, 3).courses.find(c => c.code === "BCSE202L");
    assert.equal(after.predictedGrade, "C");
    assert.equal(after.credits, 3.5);
});

test("duplicates are also collapsed within a single paste", () => {
    let s = ok(model.createSemester(model.emptyState(), 1));
    const dup = [{ code: "BCSE1", name: "Same", credits: 3 }, { code: "BCSE1", name: "Same", credits: 3 }];
    const res = model.addCourses(s, 1, dup);
    assert.equal(res.added.length, 1);
    assert.equal(res.duplicates.length, 1);
});

test("incomplete incoming courses are rejected with a reason, others still import", () => {
    const s = ok(model.createSemester(model.emptyState(), 1));
    const res = model.addCourses(s, 1, [
        { code: "A1", name: "", credits: 3 },
        { code: "A2", name: "Bad credit", credits: -4 },
        { code: "A3", name: "Fine", credits: 2 },
    ]);
    assert.deepEqual(res.added, ["Fine"]);
    assert.equal(res.rejected.length, 2);
});

test("semester size is capped", () => {
    let s = ok(model.createSemester(model.emptyState(), 1));
    const many = Array.from({ length: 45 }, (_, i) => ({ code: "C" + i, name: "Course " + i, credits: 1 }));
    const res = model.addCourses(s, 1, many);
    assert.equal(model.getSemester(res.state, 1).courses.length, model.MAX_COURSES);
    assert.equal(res.rejected.length, 5);
});

test("predicted and actual grades are independent fields", () => {
    let s = ongoingWithSample();
    const id = model.getSemester(s, 3).courses[0].id;
    s = ok(model.updateCourse(s, 3, id, { predictedGrade: "F" }));
    const c = model.getSemester(s, 3).courses[0];
    assert.equal(c.predictedGrade, "F");
    assert.equal(c.actualGrade, null);
});

test("markCompleted copies predictions into actual grades only where none exist, and keeps predictions", () => {
    let s = ongoingWithSample();
    const id = model.getSemester(s, 3).courses[0].id;
    s = ok(model.updateCourse(s, 3, id, { predictedGrade: "B", actualGrade: "A" }));
    const done = ok(model.markCompleted(s, 3));
    const sem = model.getSemester(done, 3);
    assert.equal(sem.status, "completed");
    const edited = sem.courses.find(c => c.id === id);
    assert.equal(edited.actualGrade, "A");           // existing actual grade kept
    assert.equal(edited.predictedGrade, "B");        // prediction kept
    for (const c of sem.courses.filter(c => c.id !== id)) assert.equal(c.actualGrade, "S");
    assert.match(model.markCompleted(done, 3).error, /already completed/);
});

test("after completion, editing a predicted grade cannot change actual results", () => {
    let s = ongoingWithSample();
    s = ok(model.markCompleted(s, 3));
    const before = gpa.computeSemester(model.getSemester(s, 3)).display;
    const id = model.getSemester(s, 3).courses[0].id;
    s = ok(model.updateCourse(s, 3, id, { predictedGrade: "F" }));
    assert.equal(gpa.computeSemester(model.getSemester(s, 3)).display, before);
});

test("completing the current semester moves 'current' to the next ongoing one, or null", () => {
    let s = ongoingWithSample(3);
    s = ok(model.createSemester(s, 4, { status: "ongoing" }));
    assert.equal(s.currentSemester, 3);
    s = ok(model.markCompleted(s, 3));
    assert.equal(s.currentSemester, 4);
    s = ok(model.markCompleted(s, 4));
    assert.equal(s.currentSemester, null);
});

test("reopen keeps actual grades and seeds missing predictions from them", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed" }));
    s = ok(model.addCourses(s, 1, [{ code: "X1", name: "One", credits: 3 }]));
    const id = model.getSemester(s, 1).courses[0].id;
    s = ok(model.updateCourse(s, 1, id, { actualGrade: "B" }));
    s = ok(model.reopenSemester(s, 1));
    const c = model.getSemester(s, 1).courses[0];
    assert.equal(c.actualGrade, "B");
    assert.equal(c.predictedGrade, "B");
    assert.equal(s.currentSemester, 1);
});

test("setCurrent only accepts ongoing semesters", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed" }));
    assert.match(model.setCurrent(s, 1).error, /ongoing/);
    s = ok(model.createSemester(s, 2, { status: "ongoing" }));
    assert.equal(ok(model.setCurrent(s, 2)).currentSemester, 2);
});

test("updateCourse validates input and reports friendly errors", () => {
    let s = ongoingWithSample();
    const [a, b] = model.getSemester(s, 3).courses;
    assert.match(model.updateCourse(s, 3, a.id, { name: "   " }).error, /can't be empty/);
    assert.match(model.updateCourse(s, 3, a.id, { credits: -1 }).error, /Credits must be/);
    assert.match(model.updateCourse(s, 3, a.id, { credits: 1.234 }).error, /Credits must be/);
    assert.match(model.updateCourse(s, 3, a.id, { predictedGrade: "Z" }).error, /Choose one of/);
    assert.match(model.updateCourse(s, 3, a.id, { code: b.code, name: b.name }).error, /already has/);
    assert.match(model.updateCourse(s, 3, "nope", { name: "x" }).error, /not found/);
    assert.equal(ok(model.updateCourse(s, 3, a.id, { credits: null })).semesters[0].courses[0].credits, null);
});

test("editing a completed grade recalculates actual SGPA and CGPA through the model", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed" }));
    s = ok(model.addCourses(s, 1, [{ code: "X1", name: "One", credits: 4 }]));
    const id = model.getSemester(s, 1).courses[0].id;
    s = ok(model.updateCourse(s, 1, id, { actualGrade: "B" }));
    assert.equal(gpa.computeCgpa(s.semesters).display, "8.00");
    s = ok(model.updateCourse(s, 1, id, { actualGrade: "A" }));
    assert.equal(gpa.computeSemester(model.getSemester(s, 1)).display, "9.00");
    assert.equal(gpa.computeCgpa(s.semesters).display, "9.00");
});

test("summary-only semesters: validation and restrictions", () => {
    let s = ok(model.createSemester(model.emptyState(), 1, { status: "completed", kind: "summary" }));
    assert.ok(model.addCourses(s, 1, [{ name: "x", credits: 1 }]).error);
    assert.ok(model.addBlankCourse(s, 1).error);
    assert.ok(model.reopenSemester(s, 1).error);
    assert.ok(model.setSummary(s, 1, { credits: 20, sgpa: 10.5 }).error);
    assert.ok(model.setSummary(s, 1, { credits: -1, sgpa: 8 }).error);
    s = ok(model.setSummary(s, 1, { credits: 20, sgpa: 8.5 }));
    assert.equal(gpa.computeSemester(model.getSemester(s, 1)).display, "8.50");
});

test("deleteSemester removes it and repairs 'current'", () => {
    let s = ongoingWithSample(3);
    s = ok(model.createSemester(s, 4, { status: "ongoing" }));
    s = ok(model.deleteSemester(s, 3));
    assert.equal(model.getSemester(s, 3), null);
    assert.equal(s.currentSemester, 4);
    assert.ok(model.deleteSemester(s, 3).error);
});

// ---- validateState --------------------------------------------------------------------------

const validRaw = () => ({
    schemaVersion: 1, currentSemester: 2,
    semesters: [
        { number: 1, status: "completed", kind: "courses",
          courses: [{ id: "a1", code: "X1", name: "One", credits: 3, countsToGpa: true, actualGrade: "A", predictedGrade: null }],
          summary: { credits: null, sgpa: null } },
        { number: 2, status: "ongoing", kind: "courses", courses: [] },
    ],
});

test("validateState accepts a well-formed state and keeps it as-is", () => {
    const v = model.validateState(validRaw());
    assert.equal(v.ok, true);
    assert.equal(v.state.semesters[0].courses[0].actualGrade, "A");
    assert.equal(v.state.currentSemester, 2);
});

test("validateState drops unknown fields (whitelist), including executable-looking ones", () => {
    const raw = validRaw();
    raw.evil = "<script>alert(1)</script>";
    raw.semesters[0].onload = "alert(1)";
    raw.semesters[0].courses[0].constructor = "x";
    const v = model.validateState(JSON.parse(JSON.stringify(raw)));
    assert.equal(v.ok, true);
    assert.equal(v.state.evil, undefined);
    assert.equal(v.state.semesters[0].onload, undefined);
    assert.deepEqual(Object.keys(v.state.semesters[0].courses[0]).sort(),
        ["actualGrade", "code", "countsToGpa", "credits", "id", "name", "predictedGrade"]);
});

test("a JSON payload with a literal __proto__ key cannot pollute prototypes", () => {
    const payload = JSON.parse('{"schemaVersion":1,"semesters":[],"__proto__":{"polluted":true}}');
    const v = model.validateState(payload);
    assert.equal(v.ok, true);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(v.state, "__proto__"), false);
});

test("validateState rejects structurally wrong data with reasons", () => {
    const cases = [
        [null, /not an object/],
        [[], /not an object/],
        ["str", /not an object/],
        [{ schemaVersion: 2, semesters: [] }, /unsupported schemaVersion/],
        [{ schemaVersion: 1 }, /semesters must be a list/],
        [{ schemaVersion: 1, semesters: Array(9).fill({}) }, /too many semesters/],
    ];
    for (const [raw, re] of cases) {
        const v = model.validateState(raw);
        assert.equal(v.ok, false);
        assert.match(v.errors[0], re);
    }

    const mutate = fn => { const r = validRaw(); fn(r); return model.validateState(r); };
    assert.equal(mutate(r => { r.semesters[0].status = "done"; }).ok, false);
    assert.equal(mutate(r => { r.semesters[0].number = 9; }).ok, false);
    assert.equal(mutate(r => { r.semesters[1].number = 1; }).ok, false);               // duplicate number
    assert.equal(mutate(r => { r.semesters[0].courses[0].name = ""; }).ok, false);      // incomplete record
    assert.equal(mutate(r => { r.semesters[0].courses[0].credits = "3"; }).ok, false);
    assert.equal(mutate(r => { r.semesters[0].courses[0].actualGrade = "Z"; }).ok, false);
    assert.equal(mutate(r => { r.semesters[0].courses[0].countsToGpa = "yes"; }).ok, false);
    assert.equal(mutate(r => { r.semesters[0].kind = "summary"; r.semesters[0].status = "ongoing"; }).ok, false);
    assert.equal(mutate(r => { r.semesters[0].courses = Array(41).fill(r.semesters[0].courses[0]); }).ok, false);
});

test("validateState fills safe defaults for optional fields and never invents grades", () => {
    const v = model.validateState({
        schemaVersion: 1,
        semesters: [{ number: 1, status: "completed", courses: [{ name: "Only a name" }] }],
    });
    assert.equal(v.ok, true);
    const c = v.state.semesters[0].courses[0];
    assert.equal(c.credits, null);
    assert.equal(c.actualGrade, null);
    assert.equal(c.countsToGpa, true);
    assert.match(c.id, /^[A-Za-z0-9_-]+$/);
});

test("validateState: duplicate course ids are regenerated; 'current' pointing at a non-ongoing semester is cleared", () => {
    const raw = validRaw();
    raw.semesters[0].courses.push(Object.assign({}, raw.semesters[0].courses[0], { name: "Two", code: "X2" }));
    raw.currentSemester = 1;
    const v = model.validateState(raw);
    assert.equal(v.ok, true);
    const ids = v.state.semesters[0].courses.map(c => c.id);
    assert.equal(new Set(ids).size, 2);
    assert.equal(v.state.currentSemester, null);
});

test("validateState keeps text as inert data: markup stays text, control characters are removed", () => {
    const raw = validRaw();
    raw.semesters[0].courses[0].name = '<img src=x onerror=alert(1)>\u0000\u0007 Name';
    const v = model.validateState(raw);
    assert.equal(v.ok, true);
    assert.equal(v.state.semesters[0].courses[0].name, "<img src=x onerror=alert(1)> Name");
});

test("end to end: sample timetable -> ongoing -> complete -> CGPA", () => {
    let s = ongoingWithSample(1);
    const projected = gpa.computeSemester(model.getSemester(s, 1));
    assert.equal(projected.basis, "projected");
    assert.equal(projected.credits100, 1000);            // 4 + 3 + 1.5 + 1 + 0.5; the non-graded course is not counted
    assert.equal(gpa.computeCgpa(s.semesters).status, "empty");   // nothing completed yet
    s = ok(model.markCompleted(s, 1));
    assert.equal(gpa.computeCgpa(s.semesters).display, "10.00");
});
