/*
 * GPA calculation layer (pure: no DOM, no storage).
 *
 * Rules carried over unchanged from the original main.js:
 *   - grade points: S=10 A=9 B=8 C=7 D=6 E=5 F=0
 *   - GPA = sum(credit * grade points) / sum(credit), F counts (0 points) in the denominator
 *   - courses flagged as not counting toward GPA (e.g. non-graded) are left out
 *
 * Added on top:
 *   - integer arithmetic (credits in hundredths, grade points in hundredths), so results
 *     never depend on floating-point rounding; the final 2-decimal value is rounded half-up
 *   - missing credits / missing grades are reported explicitly instead of being guessed
 *   - SGPA and CGPA both come from the same sums, so CGPA is credit-weighted, never a
 *     plain average of SGPAs
 *
 * Naming: a "100" suffix means "value x 100, held as an integer".
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports;
    var api = factory();
    if (isNode) {
        module.exports = api;
    } else {
        root.VtopGpa = root.VtopGpa || {};
        root.VtopGpa.gpa = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    var GRADES = ["S", "A", "B", "C", "D", "E", "F"];
    var GRADE_POINTS = { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, F: 0 };

    var MAX_COURSE_CREDITS = 40;

    // Course Distribution value for a Non-Graded Core Requirement. Such a course is kept in the
    // student's history but never takes part in any GPA or credit total, whatever credits or
    // grade VTOP shows for it. It is decided by this field only, never by name, grade or credits.
    var NGCR = "NGCR";

    function isNgcr(course) {
        return !!course && course.distribution === NGCR;
    }

    function has(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function isGrade(g) {
        return typeof g === "string" && has(GRADE_POINTS, g);
    }

    // credits (number, up to 2 decimals) -> integer hundredths, or null if not a valid credit
    function creditsToInt(c) {
        if (typeof c !== "number" || !isFinite(c) || c < 0 || c > MAX_COURSE_CREDITS) return null;
        var scaled = Math.round(c * 100);
        if (Math.abs(c * 100 - scaled) > 1e-6) return null;
        return scaled;
    }

    // SGPA entered by the user (0..10, up to 2 decimals) -> integer hundredths, or null
    function sgpaToInt(s) {
        if (typeof s !== "number" || !isFinite(s) || s < 0 || s > 10) return null;
        var scaled = Math.round(s * 100);
        if (Math.abs(s * 100 - scaled) > 1e-6) return null;
        return scaled;
    }

    // round-half-up of p / c for positive integers
    function roundDiv(p, c) {
        return Math.floor((2 * p + c) / (2 * c));
    }

    function formatGpa(gpa100) {
        if (gpa100 === null || gpa100 === undefined) return "—";
        var whole = Math.floor(gpa100 / 100);
        var frac = gpa100 % 100;
        return whole + "." + (frac < 10 ? "0" : "") + frac;
    }

    function formatCredits(credits100) {
        return String(Number((credits100 / 100).toFixed(2)));
    }

    // points100 = credits100 * grade * 100, so grade points = points100 / 10000
    function formatPoints(points100) {
        return String(Number((points100 / 10000).toFixed(2)));
    }

    function buildResult(parts) {
        var credits100 = parts.credits100;
        var points100 = parts.points100;
        var excluded = parts.excluded || [];
        var hasMissing = excluded.some(function (e) { return e.reason === "no-credit" || e.reason === "no-grade"; });

        var gpa100 = credits100 > 0 ? (parts.gpa100 !== undefined ? parts.gpa100 : roundDiv(points100, credits100)) : null;
        var status = hasMissing ? "incomplete" : (credits100 > 0 ? "ok" : "empty");

        return {
            basis: parts.basis,            // "actual" | "projected"
            status: status,                // "ok" | "incomplete" | "empty"
            gpa100: gpa100,
            display: formatGpa(gpa100),
            credits100: credits100,        // credits used in the calculation
            points100: points100,
            failedCredits100: parts.failedCredits100 || 0,
            countedCount: parts.countedCount || 0,
            excluded: excluded,            // [{ id, name, reason }]
            summaryOnly: !!parts.summaryOnly
        };
    }

    // Evaluate a list of courses using the given grade field ("actualGrade" | "predictedGrade").
    function evaluateCourses(courses, gradeKey, basis) {
        var credits100 = 0, points100 = 0, failed100 = 0, counted = 0;
        var excluded = [];

        (courses || []).forEach(function (c) {
            // Checked first and independent of countsToGpa, so an NGCR course can't be switched
            // back in, and a missing credit or grade on it never makes a semester "incomplete".
            if (isNgcr(c)) {
                excluded.push({ id: c.id, name: c.name, reason: "ngcr" });
                return;
            }
            if (c.countsToGpa === false) {
                excluded.push({ id: c.id, name: c.name, reason: "non-gpa" });
                return;
            }
            var c100 = creditsToInt(c.credits);
            if (c100 === null) {
                excluded.push({ id: c.id, name: c.name, reason: "no-credit" });
                return;
            }
            if (c100 === 0) {
                excluded.push({ id: c.id, name: c.name, reason: "zero-credit" });
                return;
            }
            var grade = c[gradeKey];
            if (!isGrade(grade)) {
                excluded.push({ id: c.id, name: c.name, reason: "no-grade" });
                return;
            }
            credits100 += c100;
            points100 += c100 * GRADE_POINTS[grade] * 100;
            if (grade === "F") failed100 += c100;
            counted++;
        });

        return buildResult({
            basis: basis, credits100: credits100, points100: points100,
            failedCredits100: failed100, countedCount: counted, excluded: excluded
        });
    }

    // One semester. Completed -> actual grades. Ongoing -> predicted grades (projected).
    function computeSemester(sem) {
        if (!sem) return null;
        var basis = sem.status === "completed" ? "actual" : "projected";

        if (sem.kind === "summary") {
            var s = sem.summary || {};
            var c100 = creditsToInt(s.credits);
            var g100 = sgpaToInt(s.sgpa);
            if (c100 === null || g100 === null || c100 === 0) {
                return buildResult({
                    basis: basis, credits100: 0, points100: 0, summaryOnly: true,
                    excluded: [{ id: "summary", name: "Semester summary", reason: "no-credit" }]
                });
            }
            return buildResult({
                basis: basis, credits100: c100, points100: c100 * g100,
                gpa100: g100, countedCount: 1, summaryOnly: true
            });
        }

        return evaluateCourses(sem.courses, basis === "actual" ? "actualGrade" : "predictedGrade", basis);
    }

    // Cumulative over semesters. By default only COMPLETED semesters count (actual CGPA).
    // With includeOngoing the ongoing semesters' predictions are added and the result is
    // labelled "projected"; it is never mixed into the actual figure.
    function computeCgpa(semesters, opts) {
        var includeOngoing = !!(opts && opts.includeOngoing);
        var credits100 = 0, points100 = 0, failed100 = 0;
        var used = [], incomplete = [], summaryCount = 0;

        (semesters || []).forEach(function (sem) {
            var isCompleted = sem.status === "completed";
            if (!isCompleted && !(includeOngoing && sem.status === "ongoing")) return;

            var r = computeSemester(sem);
            if (r.status === "incomplete") incomplete.push(sem.number);
            if (r.credits100 > 0) {
                credits100 += r.credits100;
                points100 += r.points100;
                failed100 += r.failedCredits100;
                used.push(sem.number);
                if (r.summaryOnly) summaryCount++;
            }
        });

        var res = buildResult({
            basis: includeOngoing ? "projected" : "actual",
            credits100: credits100, points100: points100, failedCredits100: failed100,
            countedCount: used.length,
            excluded: incomplete.map(function (n) { return { id: "sem" + n, name: "Semester " + n, reason: "no-grade" }; })
        });
        res.semesters = used;
        res.incompleteSemesters = incomplete;
        res.summaryOnlyCount = summaryCount;
        return res;
    }

    return {
        GRADES: GRADES,
        GRADE_POINTS: GRADE_POINTS,
        MAX_COURSE_CREDITS: MAX_COURSE_CREDITS,
        NGCR: NGCR,
        isNgcr: isNgcr,
        isGrade: isGrade,
        creditsToInt: creditsToInt,
        sgpaToInt: sgpaToInt,
        formatGpa: formatGpa,
        formatCredits: formatCredits,
        formatPoints: formatPoints,
        evaluateCourses: evaluateCourses,
        computeSemester: computeSemester,
        computeCgpa: computeCgpa
    };
});
