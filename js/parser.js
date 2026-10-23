/*
 * VTOP timetable parser (pure: no DOM, no storage).
 *
 * The matching rules are the ones from the original main.js, unchanged.
 * `subjects` is therefore identical to what the old parser produced
 * (tests/parser.test.js checks this against a frozen copy of the old code).
 *
 * Additions that do NOT change `subjects`:
 *   - subject.code           course code taken from the course line
 *   - subject.creditMissing  true when no LTPC line was found (credit stays 0 for parity;
 *                            the app treats it as "unknown", never as a real 0)
 *   - skipped                courses dropped because their category says "non-graded"
 *   - warnings               course blocks the old parser dropped silently
 */
(function (root, factory) {
    var isNode = typeof module === "object" && module.exports;
    var api = factory();
    if (isNode) {
        module.exports = api;
    } else {
        root.VtopGpa = root.VtopGpa || {};
        root.VtopGpa.parser = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    // Registration status that ends a course block. Two statuses are known from VTOP:
    //   "Registered and Approved"                                   (regular registration)
    //   "Registered, Invoice Generated, Fees Paid and Approved"     (retake / grade improvement)
    // The regular form keeps the original substring rule. The retake form must contain the whole
    // phrase, so other statuses ("Registered and Waiting", "Fees Not Paid", ...) are not accepted.
    // Case and runs of whitespace (tabs, non-breaking spaces) are ignored for both.
    var RETAKE_STATUS = /\bregistered\s*,\s*invoice\s+generated\s*,\s*fees\s+paid\s*,?\s*and\s+approved\b/;

    function isRegistrationStatus(line) {
        var flat = line.toLowerCase().replace(/[\s ]+/g, " ");
        return flat.includes("registered and approved") || RETAKE_STATUS.test(flat);
    }

    function parseTimetable(raw) {
        var lines = String(raw || "").split("\n").map(function (l) { return l.trim(); })
            .filter(function (l) { return l !== ""; });

        var subjects = [];
        var skipped = [];
        var warnings = [];
        var current = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var lower = line.toLowerCase();

            // 1) Course line: strict code pattern first, else looser "something - something"
            if (/^[A-Z]{2,6}\d{3}[A-Z]?\b\s*-\s*/.test(line)) {
                if (current) {
                    warnings.push({ type: "unterminated", course: current.course || "(unnamed)" });
                }
                current = {};
                current.code = line.split("-")[0].trim();
                current.course = line.split("-").slice(1).join("-").trim();
                continue;
            }

            if (!current && line.includes(" - ")) {
                var left = line.split("-")[0].trim();
                if (/[A-Z]{2,}\d{2,}/.test(left)) {
                    current = {};
                    current.code = left;
                    current.course = line.split("-").slice(1).join("-").trim();
                    continue;
                }
            }

            // 2) LTPC line ("3 0 0 0 3.0"): the last number is the credit
            if (current && /(\d+(?:\.\d+)?)(\s+\d+(?:\.\d+)?){4}$/.test(line)) {
                var m = line.match(/(\d+(?:\.\d+)?)\s*$/);
                if (m) {
                    current.credit = parseFloat(m[1]);
                }
                continue;
            }

            // 3) Category line
            if (current && (
                lower.includes("core") ||
                lower.includes("elective") ||
                lower.includes("requirement") ||
                lower.includes("sciences") ||
                lower.includes("skill") ||
                lower.includes("soft")
            )) {
                current.category = line;
                continue;
            }

            // 4) End of block
            if (current && isRegistrationStatus(line)) {
                var isNonGraded = current.category && /non-graded/i.test(current.category);
                if (!isNonGraded) {
                    if (!current.course) current.course = "Unknown Course";
                    if (typeof current.credit === "undefined" || Number.isNaN(current.credit)) {
                        current.credit = 0;
                        current.creditMissing = true;
                    }
                    subjects.push(current);
                } else {
                    skipped.push({ code: current.code, course: current.course, category: current.category });
                }
                current = null;
                continue;
            }

            // 5) Course name split across lines
            if (current && (!current.course || current.course.length < 3) && !/\d/.test(line)) {
                current.course = (current.course ? (current.course + " " + line) : line).trim();
                continue;
            }
        }

        if (current) {
            warnings.push({ type: "unterminated", course: current.course || "(unnamed)" });
        }

        subjects.sort(function (a, b) {
            return b.credit - a.credit || a.course.localeCompare(b.course);
        });

        return { subjects: subjects, skipped: skipped, warnings: warnings };
    }

    return { parseTimetable: parseTimetable, isRegistrationStatus: isRegistrationStatus };
});
