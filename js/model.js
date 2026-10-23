/*
 * Academic-profile state: shape, validation and the operations that change it.
 * Pure: no DOM, no storage. Every operation returns a NEW state and leaves its input untouched.
 *
 * State (schemaVersion 1):
 *   {
 *     schemaVersion: 1,
 *     currentSemester: 1..8 | null,           // the ongoing semester shown on the dashboard
 *     semesters: [{
 *       number: 1..8,
 *       status: "ongoing" | "completed",
 *       kind: "courses" | "summary",           // "summary" = only SGPA + credits (completed only)
 *       examPeriod?: "YYYY-MM",                // set by a grade-history import; anchors later imports
 *       courses: [{ id, code, name, credits|null, countsToGpa,
 *                   actualGrade|null, predictedGrade|null,
 *                   // optional, written by a grade-history import (absent otherwise):
 *                   distribution?, courseType?, reportedGrade?, examPeriod?, resultDeclared? }],
 *       summary: { credits|null, sgpa|null }   // only meaningful for kind "summary"
 *     }]
 *   }
 *
 * Actual and predicted grades live in separate fields, so experimenting with predictions
 * can never overwrite an actual grade.
 *
 * A course whose distribution is "NGCR" (Non-Graded Core Requirement) is kept for the record only:
 * it never counts toward GPA, has no GPA grade (what VTOP showed, e.g. "P", is in `reportedGrade`),
 * and its displayed credits are kept but never summed.
 *
 * Optional fields are only present when they have a value, so data saved by earlier versions is
 * valid as it is and stays byte-for-byte what it was until something changes it.
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports;
    var deps = isNode ? { gpa: require("./gpa"), history: require("./history") } : (root.VtopGpa || {});
    var api = factory(deps);
    if (isNode) {
        module.exports = api;
    } else {
        root.VtopGpa = root.VtopGpa || {};
        root.VtopGpa.model = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (deps) {
    var gpa = deps.gpa;
    var hist = deps.history;   // (not named "history": that is a browser global)

    var SCHEMA_VERSION = 1;
    var MAX_SEMESTER = 8;
    var MAX_COURSES = 40;
    var MAX_NAME = 120;
    var MAX_CODE = 20;
    var MAX_REPORTED_GRADE = 12;
    var PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
    var DEFAULT_GRADE = "S";   // same default the original dropdown had

    function emptyState() {
        return { schemaVersion: SCHEMA_VERSION, currentSemester: null, semesters: [] };
    }

    function clone(x) {
        return JSON.parse(JSON.stringify(x));
    }

    function newId() {
        return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function isPlainObject(x) {
        return x !== null && typeof x === "object" && !Array.isArray(x);
    }

    function isSemesterNumber(n) {
        return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_SEMESTER;
    }

    // Strip control characters, collapse whitespace, cap length. Output is only ever rendered
    // with textContent, but we keep stored text tidy anyway.
    function cleanText(s, max) {
        if (typeof s !== "string") return "";
        return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    }

    function courseKey(c) {
        var code = cleanText(c.code, MAX_CODE).toUpperCase();
        if (code) return "code:" + code;
        return "name:" + cleanText(c.name, MAX_NAME).toLowerCase();
    }

    // ---- validation / normalisation -------------------------------------------------------

    function normalizeGrade(g, label, errors) {
        if (g === null || g === undefined) return null;
        if (gpa.isGrade(g)) return g;
        errors.push(label + ": unsupported grade " + JSON.stringify(g));
        return null;
    }

    // Optional text field: absent -> "", wrong type -> error.
    function optionalText(v, max, label, errors) {
        if (v === undefined || v === null) return "";
        if (typeof v !== "string") { errors.push(label + " must be text"); return ""; }
        return cleanText(v, max);
    }

    // Optional "YYYY-MM" exam period: absent -> null, malformed -> error.
    function optionalPeriod(v, label, errors) {
        if (v === undefined || v === null || v === "") return null;
        if (typeof v !== "string" || !PERIOD_KEY.test(v)) { errors.push(label + ": invalid exam period " + JSON.stringify(v)); return null; }
        return v;
    }

    function normalizeCourse(input, where, errors) {
        if (!isPlainObject(input)) {
            errors.push(where + ": not an object");
            return null;
        }
        var before = errors.length;
        var name = cleanText(input.name, MAX_NAME);
        if (!name) errors.push(where + ": course name is required");

        var credits = null;
        if (input.credits !== null && input.credits !== undefined) {
            if (gpa.creditsToInt(input.credits) === null) {
                errors.push(where + ": invalid credits " + JSON.stringify(input.credits));
            } else {
                credits = input.credits;
            }
        }
        if (input.countsToGpa !== undefined && typeof input.countsToGpa !== "boolean") {
            errors.push(where + ": countsToGpa must be true or false");
        }
        var actual = normalizeGrade(input.actualGrade, where + " actualGrade", errors);
        var predicted = normalizeGrade(input.predictedGrade, where + " predictedGrade", errors);

        var distribution = optionalText(input.distribution, hist.MAX_DISTRIBUTION, where + ": distribution", errors).toUpperCase();
        var courseType = optionalText(input.courseType, hist.MAX_TYPE, where + ": courseType", errors);
        var reportedGrade = optionalText(input.reportedGrade, MAX_REPORTED_GRADE, where + ": reportedGrade", errors);
        var resultDeclared = optionalText(input.resultDeclared, hist.MAX_DECLARED, where + ": resultDeclared", errors);
        var examPeriod = optionalPeriod(input.examPeriod, where, errors);

        if (errors.length > before) return null;
        var id = typeof input.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(input.id) ? input.id : newId();

        // An NGCR course can't count and has no GPA grade, whatever the incoming object says.
        var ngcr = distribution === gpa.NGCR;
        var course = {
            id: id,
            code: cleanText(input.code, MAX_CODE),
            name: name,
            credits: credits,
            countsToGpa: ngcr ? false : input.countsToGpa !== false,
            actualGrade: ngcr ? null : actual,
            predictedGrade: ngcr ? null : predicted
        };
        if (distribution) course.distribution = distribution;
        if (courseType) course.courseType = courseType;
        if (reportedGrade) course.reportedGrade = reportedGrade;
        if (examPeriod) course.examPeriod = examPeriod;
        if (resultDeclared) course.resultDeclared = resultDeclared;
        return course;
    }

    function normalizeSemester(input, index, errors) {
        var where = "semesters[" + index + "]";
        if (!isPlainObject(input)) {
            errors.push(where + ": not an object");
            return null;
        }
        var before = errors.length;
        if (!isSemesterNumber(input.number)) errors.push(where + ": number must be an integer 1-" + MAX_SEMESTER);
        if (input.status !== "ongoing" && input.status !== "completed") errors.push(where + ": status must be ongoing or completed");
        var kind = input.kind === undefined ? "courses" : input.kind;
        if (kind !== "courses" && kind !== "summary") errors.push(where + ": kind must be courses or summary");
        if (kind === "summary" && input.status === "ongoing") errors.push(where + ": a summary-only semester must be completed");

        var courses = [];
        if (input.courses !== undefined) {
            if (!Array.isArray(input.courses)) {
                errors.push(where + ": courses must be a list");
            } else if (input.courses.length > MAX_COURSES) {
                errors.push(where + ": too many courses (max " + MAX_COURSES + ")");
            } else {
                var seen = {};
                input.courses.forEach(function (c, i) {
                    var norm = normalizeCourse(c, where + ".courses[" + i + "]", errors);
                    if (norm) {
                        if (seen[norm.id]) norm.id = newId();
                        seen[norm.id] = true;
                        courses.push(norm);
                    }
                });
            }
        }

        var summary = { credits: null, sgpa: null };
        if (input.summary !== undefined && input.summary !== null) {
            if (!isPlainObject(input.summary)) {
                errors.push(where + ": summary must be an object");
            } else {
                var s = input.summary;
                if (s.credits !== null && s.credits !== undefined) {
                    if (gpa.creditsToInt(s.credits) === null) errors.push(where + ": invalid summary credits");
                    else summary.credits = s.credits;
                }
                if (s.sgpa !== null && s.sgpa !== undefined) {
                    if (gpa.sgpaToInt(s.sgpa) === null) errors.push(where + ": invalid summary SGPA");
                    else summary.sgpa = s.sgpa;
                }
            }
        }

        var examPeriod = optionalPeriod(input.examPeriod, where, errors);

        if (errors.length > before) return null;
        var sem = {
            number: input.number,
            status: input.status,
            kind: kind,
            courses: kind === "courses" ? courses : [],
            summary: summary
        };
        if (examPeriod) sem.examPeriod = examPeriod;
        return sem;
    }

    // Validate arbitrary parsed JSON and return a clean, whitelisted copy.
    // Unknown fields are dropped; nothing from `raw` is ever copied by key name.
    function validateState(raw) {
        var errors = [];
        if (!isPlainObject(raw)) return { ok: false, errors: ["data is not an object"] };
        if (raw.schemaVersion !== SCHEMA_VERSION) {
            return { ok: false, errors: ["unsupported schemaVersion " + JSON.stringify(raw.schemaVersion)],
                     unsupportedVersion: true };
        }
        if (!Array.isArray(raw.semesters)) return { ok: false, errors: ["semesters must be a list"] };
        if (raw.semesters.length > MAX_SEMESTER) return { ok: false, errors: ["too many semesters"] };

        var semesters = [];
        var seen = {};
        raw.semesters.forEach(function (s, i) {
            var norm = normalizeSemester(s, i, errors);
            if (!norm) return;
            if (seen[norm.number]) { errors.push("semesters[" + i + "]: duplicate semester " + norm.number); return; }
            seen[norm.number] = true;
            semesters.push(norm);
        });
        if (errors.length) return { ok: false, errors: errors.slice(0, 20) };

        semesters.sort(function (a, b) { return a.number - b.number; });

        var current = raw.currentSemester;
        var currentOk = isSemesterNumber(current) && semesters.some(function (s) {
            return s.number === current && s.status === "ongoing";
        });

        return {
            ok: true,
            state: { schemaVersion: SCHEMA_VERSION, currentSemester: currentOk ? current : null, semesters: semesters }
        };
    }

    // ---- queries --------------------------------------------------------------------------

    function getSemester(state, number) {
        for (var i = 0; i < state.semesters.length; i++) {
            if (state.semesters[i].number === number) return state.semesters[i];
        }
        return null;
    }

    function firstFreeNumber(state) {
        for (var n = 1; n <= MAX_SEMESTER; n++) if (!getSemester(state, n)) return n;
        return null;
    }

    function pickCurrent(state) {
        var ongoing = state.semesters.filter(function (s) { return s.status === "ongoing"; });
        return ongoing.length ? ongoing[0].number : null;
    }

    // ---- operations -----------------------------------------------------------------------

    function withSemester(state, number, fn) {
        var next = clone(state);
        var sem = getSemester(next, number);
        if (!sem) return { error: "Semester " + number + " does not exist." };
        var out = fn(sem, next);
        if (out && out.error) return out;
        return Object.assign({ state: next }, out || {});
    }

    function createSemester(state, number, opts) {
        opts = opts || {};
        var status = opts.status || "ongoing";
        var kind = opts.kind || "courses";
        if (!isSemesterNumber(number)) return { error: "Semester must be a number from 1 to " + MAX_SEMESTER + "." };
        if (getSemester(state, number)) return { error: "Semester " + number + " already exists." };
        if (kind === "summary" && status !== "completed") return { error: "A summary-only semester must be completed." };

        var next = clone(state);
        next.semesters.push({
            number: number, status: status, kind: kind, courses: [],
            summary: { credits: null, sgpa: null }
        });
        next.semesters.sort(function (a, b) { return a.number - b.number; });
        if (status === "ongoing" && next.currentSemester === null) next.currentSemester = number;
        return { state: next };
    }

    function deleteSemester(state, number) {
        return withSemester(state, number, function (sem, next) {
            next.semesters = next.semesters.filter(function (s) { return s.number !== number; });
            if (next.currentSemester === number) next.currentSemester = pickCurrent(next);
        });
    }

    // incoming: [{ code, name, credits|null }]. Never removes or overwrites existing courses.
    function addCourses(state, number, incoming) {
        return withSemester(state, number, function (sem) {
            if (sem.kind !== "courses") return { error: "This semester only stores a summary, not courses." };
            var keys = {};
            sem.courses.forEach(function (c) { keys[courseKey(c)] = true; });
            var added = [], duplicates = [], rejected = [];

            incoming.forEach(function (inc) {
                var errs = [];
                var base = {
                    code: inc.code, name: inc.name, credits: inc.credits === undefined ? null : inc.credits,
                    countsToGpa: inc.countsToGpa !== false,
                    actualGrade: sem.status === "completed" ? DEFAULT_GRADE : null,
                    predictedGrade: sem.status === "ongoing" ? DEFAULT_GRADE : null
                };
                var course = normalizeCourse(base, "course", errs);
                if (!course) { rejected.push({ name: cleanText(inc.name, MAX_NAME) || "(unnamed)", reason: errs[0] }); return; }
                var key = courseKey(course);
                if (keys[key]) { duplicates.push(course.name); return; }
                if (sem.courses.length >= MAX_COURSES) { rejected.push({ name: course.name, reason: "semester is full (max " + MAX_COURSES + " courses)" }); return; }
                keys[key] = true;
                sem.courses.push(course);
                added.push(course.name);
            });
            return { added: added, duplicates: duplicates, rejected: rejected };
        });
    }

    function addBlankCourse(state, number) {
        return withSemester(state, number, function (sem) {
            if (sem.kind !== "courses") return { error: "This semester only stores a summary, not courses." };
            if (sem.courses.length >= MAX_COURSES) return { error: "A semester can hold at most " + MAX_COURSES + " courses." };
            var n = 1, names = {};
            sem.courses.forEach(function (c) { names[c.name] = true; });
            while (names["New course " + n]) n++;
            sem.courses.push({
                id: newId(), code: "", name: "New course " + n, credits: null, countsToGpa: true,
                actualGrade: sem.status === "completed" ? DEFAULT_GRADE : null,
                predictedGrade: sem.status === "ongoing" ? DEFAULT_GRADE : null
            });
        });
    }

    function friendlyError(msg) {
        if (/name is required/.test(msg)) return "Course name can't be empty.";
        if (/invalid credits/.test(msg)) return "Credits must be a number from 0 to " + gpa.MAX_COURSE_CREDITS + " with at most 2 decimals.";
        if (/grade/.test(msg)) return "Choose one of S, A, B, C, D, E or F.";
        return msg.replace(/^course: /, "");
    }

    // patch may contain: name, code, credits, countsToGpa, actualGrade, predictedGrade
    function updateCourse(state, number, courseId, patch) {
        return withSemester(state, number, function (sem) {
            var course = null;
            sem.courses.forEach(function (c) { if (c.id === courseId) course = c; });
            if (!course) return { error: "Course not found." };

            if (gpa.isNgcr(course)) {
                if (patch.countsToGpa === true) return { error: "A non-graded (NGCR) course can't count toward GPA." };
                if (patch.actualGrade != null || patch.predictedGrade != null) return { error: "A non-graded (NGCR) course has no GPA grade." };
            }

            var merged = Object.assign({}, course);
            ["name", "code", "credits", "countsToGpa", "actualGrade", "predictedGrade"].forEach(function (k) {
                if (Object.prototype.hasOwnProperty.call(patch, k)) merged[k] = patch[k];
            });
            var errs = [];
            var norm = normalizeCourse(merged, "course", errs);
            if (!norm) return { error: friendlyError(errs[0]) };

            var clash = sem.courses.some(function (c) { return c.id !== courseId && courseKey(c) === courseKey(norm); });
            if (clash) return { error: "Another course in this semester already has that name/code." };

            norm.id = course.id;
            Object.keys(norm).forEach(function (k) { course[k] = norm[k]; });
        });
    }

    function removeCourse(state, number, courseId) {
        return withSemester(state, number, function (sem) {
            var before = sem.courses.length;
            sem.courses = sem.courses.filter(function (c) { return c.id !== courseId; });
            if (sem.courses.length === before) return { error: "Course not found." };
        });
    }

    function setSummary(state, number, summary) {
        return withSemester(state, number, function (sem) {
            if (sem.kind !== "summary") return { error: "This semester stores courses, not a summary." };
            var s = { credits: null, sgpa: null };
            if (summary.credits !== null && summary.credits !== undefined) {
                if (gpa.creditsToInt(summary.credits) === null) return { error: "Credits must be a number from 0 to " + gpa.MAX_COURSE_CREDITS + " with at most 2 decimals." };
                s.credits = summary.credits;
            }
            if (summary.sgpa !== null && summary.sgpa !== undefined) {
                if (gpa.sgpaToInt(summary.sgpa) === null) return { error: "SGPA must be a number from 0 to 10 with at most 2 decimals." };
                s.sgpa = summary.sgpa;
            }
            sem.summary = s;
        });
    }

    // Projected -> actual. Actual grades start as the predicted ones (only where no actual
    // grade exists yet) and the student can correct them afterwards. Predictions are kept.
    function markCompleted(state, number) {
        return withSemester(state, number, function (sem, next) {
            if (sem.status === "completed") return { error: "Semester " + number + " is already completed." };
            sem.status = "completed";
            sem.courses.forEach(function (c) {
                if (c.actualGrade === null) c.actualGrade = c.predictedGrade;
            });
            if (next.currentSemester === number) next.currentSemester = pickCurrent(next);
        });
    }

    // Completed -> ongoing again (e.g. marked by mistake). Actual grades are kept untouched.
    function reopenSemester(state, number) {
        return withSemester(state, number, function (sem, next) {
            if (sem.status === "ongoing") return { error: "Semester " + number + " is already ongoing." };
            if (sem.kind === "summary") return { error: "A summary-only semester can't be reopened." };
            sem.status = "ongoing";
            sem.courses.forEach(function (c) {
                if (c.predictedGrade === null) c.predictedGrade = c.actualGrade;
            });
            if (next.currentSemester === null) next.currentSemester = number;
        });
    }

    function setCurrent(state, number) {
        return withSemester(state, number, function (sem, next) {
            if (sem.status !== "ongoing") return { error: "Only an ongoing semester can be the current one." };
            next.currentSemester = number;
        });
    }

    // Moves an ongoing semester to a free number (used so a grade history can take the number the
    // ongoing semester was saved under). Completed semesters are never renumbered: their number
    // is tied to their exam period.
    function moveSemester(state, from, to) {
        return withSemester(state, from, function (sem, next) {
            if (sem.status !== "ongoing") return { error: "Only an ongoing semester can be moved." };
            if (!isSemesterNumber(to)) return { error: "Semester must be a number from 1 to " + MAX_SEMESTER + "." };
            if (getSemester(next, to)) return { error: "Semester " + to + " already exists." };
            sem.number = to;
            if (next.currentSemester === from) next.currentSemester = to;
            next.semesters.sort(function (a, b) { return a.number - b.number; });
        });
    }

    // ---- grade-history import ---------------------------------------------------------------
    //
    // A parsed grade table (history.parseGradeHistory) is merged into the saved state in two steps:
    //   planHistoryImport  - read-only. Decides, row by row, what would happen and why.
    //   applyHistoryImport - rebuilds that plan from the CURRENT state and applies it all-or-nothing.
    //
    // Rules:
    //   - A course is identified by its normalised course code, never by its title.
    //   - One counted record per course. A newer result overwrites the existing record IN PLACE
    //     (it keeps its semester) with the new grade, credits and metadata. Predicted grades are
    //     never touched. An older result never replaces a newer one.
    //   - Rows that cannot be used are reported, not guessed. A row that is unusable is never
    //     allowed to let an older attempt silently stand in for a newer one: that is warned about.
    //   - Semesters come from exam periods (history.assignSemesters), anchored to saved data.
    //     Summary-only semesters, ongoing semesters and semesters holding another exam period are
    //     never written into; the student resolves those in the review screen.

    function periodLabel(key) {
        var p = hist.normalizePeriod(key);
        return p.ok ? p.label : key;
    }

    function brief(row) {
        return { line: row.line, grade: row.grade, credits: row.credits, periodKey: row.period.key,
                 periodLabel: row.period.label, ngcr: row.isNgcr };
    }

    // Semantic checks the parser can't make (it knows nothing about the grade scale).
    function checkHistoryRows(rows, plan) {
        return rows.filter(function (row) {
            var reasons = [];
            if (!row.isNgcr) {
                if (!row.grade) reasons.push("grade is missing");
                else if (!gpa.isGrade(row.grade)) reasons.push("grade “" + row.grade + "” is not supported (use S, A, B, C, D, E or F)");
                if (gpa.creditsToInt(row.credits) === null) reasons.push("credits are missing or invalid");
            } else if (row.credits !== null && gpa.creditsToInt(row.credits) === null) {
                reasons.push("credits are invalid");
            }
            if (!reasons.length) return true;
            plan.rejected.push({ line: row.line, text: row.raw, reasons: reasons, code: row.code, periodKey: row.period.key });
            return false;
        });
    }

    // One row per course code. Latest exam period wins; within one period the later line wins and
    // the disagreement is reported as a conflict (identical repeats are just duplicates).
    function dedupeHistoryRows(rows, plan) {
        var order = [], groups = {};
        rows.forEach(function (r) {
            if (!groups[r.code]) { groups[r.code] = []; order.push(r.code); }
            groups[r.code].push(r);
        });
        return order.map(function (code) {
            var g = groups[code].slice().sort(function (a, b) {
                if (a.period.key !== b.period.key) return a.period.key < b.period.key ? 1 : -1;
                return b.line - a.line;
            });
            var win = g[0];
            g.slice(1).forEach(function (o) {
                var samePeriod = o.period.key === win.period.key;
                var identical = samePeriod && o.grade === win.grade && o.credits === win.credits && o.distribution === win.distribution;
                var entry = { code: code, title: win.title, kind: !samePeriod ? "older" : identical ? "duplicate" : "conflict",
                              kept: brief(win), dropped: brief(o) };
                plan.superseded.push(entry);
                if (entry.kind === "conflict") plan.conflicts.push(entry);
            });
            return win;
        });
    }

    // The semester with the lowest number that already has a known exam period.
    function savedAnchor(state) {
        var best = null;
        state.semesters.forEach(function (s) {
            if (s.examPeriod && (!best || s.number < best.semester)) best = { key: s.examPeriod, semester: s.number };
        });
        return best;
    }

    // Exam periods -> semester numbers (+ the student's own overrides), then whether each target
    // semester can take the data. Fills plan.periods and plan.ongoingMoves; returns key -> info.
    function resolveHistoryPeriods(state, allRows, opts, plan) {
        var counts = {};
        allRows.forEach(function (r) { counts[r.period.key] = (counts[r.period.key] || 0) + 1; });

        var assignment = hist.assignSemesters(allRows.map(function (r) { return r.period; }),
            { anchor: savedAnchor(state), maxSemester: MAX_SEMESTER });
        plan.anchor = assignment.anchor;

        var overrides = opts.periodOverrides || {};
        var byKey = {}, claimed = {}, ongoing = [];

        Object.keys(counts).sort().forEach(function (key) {
            var info = { key: key, label: periodLabel(key), rows: counts[key], semester: null, auto: false,
                         status: "unassigned", reason: "", movable: false };
            var chosen = overrides[key];
            var skipped = chosen === "none";
            if (!skipped && chosen !== undefined && chosen !== null && chosen !== "") {
                if (isSemesterNumber(Number(chosen))) info.semester = Number(chosen);
                else plan.warnings.push("The semester chosen for " + info.label + " is not valid and was ignored.");
            }
            if (!skipped && info.semester === null && assignment.assignments[key] !== undefined) {
                info.semester = assignment.assignments[key];
                info.auto = true;
            }
            if (skipped) {
                info.status = "skipped";
                info.reason = "Not imported: you chose to skip " + info.label + ".";
            } else if (info.semester === null) {
                var why = assignment.unsupported.filter(function (u) { return u.key === key; })[0];
                info.reason = (why ? why.reason : info.label + " could not be placed in a semester") +
                    ". Choose a semester for it, or it will not be imported.";
            } else {
                var n = info.semester, sem = getSemester(state, n);
                if (claimed[n]) {
                    info.status = "blocked";
                    info.reason = "Semester " + n + " is already used by " + periodLabel(claimed[n]) + ".";
                } else if (!sem) {
                    info.status = "new";
                } else if (sem.kind === "summary") {
                    info.status = "blocked";
                    info.reason = "Semester " + n + " is stored as an SGPA summary, so it can't hold courses. Delete it first to import its courses.";
                } else if (sem.status === "ongoing") {
                    info.status = "blocked";
                    info.movable = true;
                    ongoing.push(info);
                } else if (sem.examPeriod && sem.examPeriod !== key) {
                    info.status = "blocked";
                    info.reason = "Semester " + n + " already holds results from " + periodLabel(sem.examPeriod) + ".";
                } else {
                    info.status = "existing";
                }
                if (info.status !== "blocked" || info.movable) claimed[n] = key;
            }
            byKey[key] = info;
            plan.periods.push(info);
        });

        planOngoingMoves(state, ongoing, opts, plan);
        return byKey;
    }

    // An ongoing semester sitting where the history needs a number can be moved to the first free
    // number after everything else, but only if the student agrees (opts.moveOngoing).
    function planOngoingMoves(state, ongoing, opts, plan) {
        if (!ongoing.length) return;
        var highest = 0;
        state.semesters.forEach(function (s) { highest = Math.max(highest, s.number); });
        plan.periods.forEach(function (p) { if (p.semester !== null) highest = Math.max(highest, p.semester); });

        ongoing.sort(function (a, b) { return a.semester - b.semester; }).forEach(function (info) {
            var to = ++highest;
            if (to > MAX_SEMESTER) {
                info.movable = false;
                info.reason = "Semester " + info.semester + " is your ongoing semester and there is no free semester to move it to.";
                return;
            }
            var move = { from: info.semester, to: to, applied: !!opts.moveOngoing };
            plan.ongoingMoves.push(move);
            if (move.applied) info.status = "new";
            else info.reason = "Semester " + info.semester + " is your ongoing semester. Move it to Semester " + to + " to import " + info.label + " here.";
        });
    }

    // Every saved record of this course code: [{ sem, course }], latest semester first.
    function findSavedCourses(state, code) {
        var found = [];
        state.semesters.forEach(function (sem) {
            if (sem.kind !== "courses") return;
            sem.courses.forEach(function (c) {
                if (c.code && hist.normalizeCode(c.code) === code) found.push({ sem: sem, course: c });
            });
        });
        return found.sort(function (a, b) { return b.sem.number - a.sem.number; });
    }

    // How a row compares with the record already saved: newer / same / older / unknown.
    // The record's own exam period is used when known; otherwise the semester it sits in.
    function compareRecency(row, rowSemester, saved) {
        var e = saved.course;
        if (e.examPeriod) {
            return row.period.key > e.examPeriod ? "newer" : row.period.key < e.examPeriod ? "older" : "same";
        }
        if (rowSemester === null) return "unknown";
        return rowSemester > saved.sem.number ? "newer" : rowSemester < saved.sem.number ? "older" : "same";
    }

    // The fields a history row writes onto a course record.
    function courseFields(row) {
        return {
            code: row.code,
            credits: row.credits,
            countsToGpa: !row.isNgcr,
            actualGrade: row.isNgcr ? null : row.grade,
            distribution: row.distribution || "",
            courseType: row.type || "",
            reportedGrade: row.isNgcr && row.grade ? row.grade : null,
            examPeriod: row.period.key,
            resultDeclared: row.resultDeclared || null
        };
    }

    function sameResult(c, f) {
        return c.code === f.code && c.credits === f.credits && c.actualGrade === f.actualGrade &&
            (c.distribution || "") === f.distribution && (c.courseType || "") === f.courseType &&
            (c.reportedGrade || null) === f.reportedGrade && (c.examPeriod || null) === f.examPeriod &&
            (c.resultDeclared || null) === f.resultDeclared &&
            (f.countsToGpa === false ? c.countsToGpa === false : !gpa.isNgcr(c));
    }

    function describeSaved(c) {
        return { grade: c.actualGrade || c.reportedGrade || null, credits: c.credits, periodKey: c.examPeriod || null };
    }

    function historyItem(action, kind, reason, row, extra) {
        return Object.assign({ action: action, kind: kind, reason: reason, code: row.code, title: row.title,
                               semester: null, row: brief(row), fields: courseFields(row) }, extra || {});
    }

    function planSavedCourse(row, info, saved, plan) {
        if (saved.length > 1) {
            plan.warnings.push(row.code + " is saved " + saved.length + " times (Semesters " +
                saved.map(function (s) { return s.sem.number; }).join(", ") +
                "). Only the latest record is considered; remove the others so it isn't counted twice.");
        }
        var s = saved[0];
        var where = { semester: s.sem.number, existingId: s.course.id, before: describeSaved(s.course) };

        if (s.sem.status === "ongoing") {
            return historyItem("skip", "pending-retake",
                row.code + " is registered in your ongoing Semester " + s.sem.number + " (a retake). The earlier result was not added, so the course isn't counted twice.",
                row, where);
        }
        var rel = compareRecency(row, info ? info.semester : null, s);
        if (rel === "older") {
            return historyItem("skip", "older",
                "Your saved result (" + (s.course.examPeriod ? periodLabel(s.course.examPeriod) : "Semester " + s.sem.number) +
                ") is newer than this one (" + row.period.label + "), so it was kept.", row, where);
        }
        if (rel === "unknown") {
            return historyItem("skip", "unplaced",
                "Its exam period (" + row.period.label + ") can't be placed in a semester, so it can't be compared with your saved result. Choose a semester for it to include it.",
                row, where);
        }
        if (sameResult(s.course, courseFields(row))) {
            return historyItem("unchanged", "same", "Already up to date.", row, where);
        }
        return historyItem("overwrite", rel === "same" ? "revised" : "retake",
            rel === "same" ? "Same exam period, but the result differs: your saved record is updated."
                           : "Newer result: replaces your saved " + (s.course.actualGrade || s.course.reportedGrade || "record") + ".",
            row, where);
    }

    function planNewCourse(row, info, state, usage) {
        if (!info || info.semester === null) {
            return historyItem("skip", "unassigned", info ? info.reason : "No exam period.", row);
        }
        if (info.status === "blocked") return historyItem("skip", "blocked", info.reason, row, { semester: info.semester });
        var sem = info.status === "existing" ? getSemester(state, info.semester) : null;
        usage[info.semester] = (usage[info.semester] || 0) + 1;
        if ((sem ? sem.courses.length : 0) + usage[info.semester] > MAX_COURSES) {
            return historyItem("skip", "full", "Semester " + info.semester + " is full (max " + MAX_COURSES + " courses).", row, { semester: info.semester });
        }
        return historyItem("add", "new", "New course.", row, { semester: info.semester });
    }

    // A row that could not be read, for a course whose usable result is OLDER, means the older
    // result is being used while a newer attempt exists. Say so.
    function warnNewerUnreadable(winners, plan) {
        var byCode = {};
        winners.forEach(function (w) { byCode[w.code] = w; });
        plan.rejected.forEach(function (rj) {
            var w = rj.code && byCode[rj.code];
            if (w && rj.periodKey && rj.periodKey > w.period.key) {
                plan.warnings.push("Line " + rj.line + " (" + rj.code + ", " + periodLabel(rj.periodKey) + ") is newer than the result used (" +
                    w.period.label + ") but could not be read. Check that row.");
            }
        });
    }

    function planHistoryImport(state, parsed, opts) {
        opts = opts || {};
        var plan = { error: null, anchor: null, periods: [], items: [], rejected: [], superseded: [], conflicts: [],
                     warnings: [], ignored: [], ongoingMoves: [], counts: null, importable: false };
        if (!parsed || !parsed.headerFound) {
            plan.error = (parsed && parsed.error) || "No grade table was found.";
            return plan;
        }
        plan.ignored = parsed.ignored.slice();
        plan.rejected = parsed.rejected.map(function (r) { return Object.assign({}, r); });

        var winners = dedupeHistoryRows(checkHistoryRows(parsed.rows, plan), plan);
        var periods = resolveHistoryPeriods(state, parsed.rows, opts, plan);

        var usage = {};
        winners.forEach(function (row) {
            var info = periods[row.period.key] || null;
            if (info && info.status === "skipped") {      // the student left this period out: touch nothing
                plan.items.push(historyItem("skip", "skipped", info.reason, row));
                return;
            }
            var saved = findSavedCourses(state, row.code);
            plan.items.push(saved.length ? planSavedCourse(row, info, saved, plan) : planNewCourse(row, info, state, usage));
        });
        warnNewerUnreadable(winners, plan);

        var counts = { add: 0, overwrite: 0, unchanged: 0, skip: 0, rejected: plan.rejected.length, superseded: plan.superseded.length };
        plan.items.forEach(function (it) { counts[it.action]++; });
        plan.counts = counts;
        plan.importable = counts.add + counts.overwrite > 0;
        return plan;
    }

    function setOptional(course, key, value) {
        if (value === null || value === "" || value === undefined) delete course[key];
        else course[key] = value;
    }

    function overwriteCourse(course, f) {
        var wasNgcr = gpa.isNgcr(course);
        course.code = f.code;
        course.credits = f.credits;
        course.actualGrade = f.actualGrade;
        // the student's own "don't count" choice survives, unless it only existed because of NGCR
        course.countsToGpa = f.countsToGpa === false ? false : (wasNgcr ? true : course.countsToGpa);
        if (f.countsToGpa === false) course.predictedGrade = null;
        ["distribution", "courseType", "reportedGrade", "examPeriod", "resultDeclared"].forEach(function (k) {
            setOptional(course, k, f[k]);
        });
    }

    // Returns { state, plan } on success, or { error, plan } with the given state untouched.
    function applyHistoryImport(state, parsed, opts) {
        var plan = planHistoryImport(state, parsed, opts);
        if (plan.error) return { error: plan.error, plan: plan };

        var next = clone(state);
        function fail(msg) { return { error: msg + " Nothing was changed.", plan: plan }; }

        for (var i = 0; i < plan.ongoingMoves.length; i++) {
            var mv = plan.ongoingMoves[i];
            if (!mv.applied) continue;
            var moved = moveSemester(next, mv.from, mv.to);
            if (moved.error) return fail(moved.error);
            next = moved.state;
        }

        for (var k = 0; k < plan.items.length; k++) {
            var item = plan.items[k];
            if (item.action === "add") {
                var sem = getSemester(next, item.semester);
                if (!sem) {
                    var created = createSemester(next, item.semester, { status: "completed" });
                    if (created.error) return fail(created.error);
                    next = created.state;
                    sem = getSemester(next, item.semester);
                }
                if (!sem.examPeriod) sem.examPeriod = item.row.periodKey;
                var errs = [];
                var course = normalizeCourse(Object.assign({ name: item.title, predictedGrade: null }, item.fields), "course", errs);
                if (!course) return fail("Could not add " + item.code + " (" + friendlyError(errs[0]) + ").");
                sem.courses.push(course);
            } else if (item.action === "overwrite") {
                var target = getSemester(next, item.semester);
                var existing = null;
                if (target) target.courses.forEach(function (c) { if (c.id === item.existingId) existing = c; });
                if (!existing) return fail("Could not find the saved record of " + item.code + ".");
                overwriteCourse(existing, item.fields);
            }
        }

        var checked = validateState(next);
        if (!checked.ok) return fail("The import would have produced invalid data (" + checked.errors[0] + ").");
        return { state: checked.state, plan: plan };
    }

    return {
        SCHEMA_VERSION: SCHEMA_VERSION,
        MAX_SEMESTER: MAX_SEMESTER,
        MAX_COURSES: MAX_COURSES,
        MAX_NAME: MAX_NAME,
        DEFAULT_GRADE: DEFAULT_GRADE,
        emptyState: emptyState,
        validateState: validateState,
        getSemester: getSemester,
        firstFreeNumber: firstFreeNumber,
        courseKey: courseKey,
        createSemester: createSemester,
        deleteSemester: deleteSemester,
        addCourses: addCourses,
        addBlankCourse: addBlankCourse,
        updateCourse: updateCourse,
        removeCourse: removeCourse,
        setSummary: setSummary,
        markCompleted: markCompleted,
        reopenSemester: reopenSemester,
        setCurrent: setCurrent,
        moveSemester: moveSemester,
        planHistoryImport: planHistoryImport,
        applyHistoryImport: applyHistoryImport
    };
});
