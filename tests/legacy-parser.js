// FROZEN COPY of the parsing loop from the original main.js (commit 7310939).
// Only the DOM wiring (getElementById / displaySubjects / showGPARows / console.log)
// was removed. The loop body is byte-for-byte the production logic.
// It is the oracle the refactored parser must stay equivalent to. Do not "improve" it.

function legacyParse(raw) {
    raw = raw || "";
    const lines = raw.split("\n").map(l => l.trim()).filter(l => l !== "");

    const subjects = [];
    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/^[A-Z]{2,6}\d{3}[A-Z]?\b\s*-\s*/.test(line)) {
            current = {};
            current.course = line.split("-").slice(1).join("-").trim();
            continue;
        }

        if (!current && line.includes(" - ")) {
            const left = line.split("-")[0].trim();
            if (/[A-Z]{2,}\d{2,}/.test(left)) {
                current = {};
                current.course = line.split("-").slice(1).join("-").trim();
                continue;
            }
        }

        if (current && /(\d+(?:\.\d+)?)(\s+\d+(?:\.\d+)?){4}$/.test(line)) {
            const m = line.match(/(\d+(?:\.\d+)?)\s*$/);
            if (m) {
                current.credit = parseFloat(m[1]);
            }
            continue;
        }

        if (current && (
            line.toLowerCase().includes("core") ||
            line.toLowerCase().includes("elective") ||
            line.toLowerCase().includes("requirement") ||
            line.toLowerCase().includes("sciences") ||
            line.toLowerCase().includes("skill") ||
            line.toLowerCase().includes("soft")
        )) {
            current.category = line;
            continue;
        }

        if (current && line.toLowerCase().includes("registered and approved")) {
            const isNonGraded = current.category && /non-graded/i.test(current.category);
            if (!isNonGraded) {
                if (!current.course) current.course = "Unknown Course";
                if (typeof current.credit === "undefined" || Number.isNaN(current.credit)) {
                    current.credit = 0;
                }
                subjects.push(current);
            }
            current = null;
            continue;
        }

        if (current && (!current.course || current.course.length < 3) && !/\d/.test(line)) {
            current.course = (current.course ? (current.course + " " + line) : line).trim();
            continue;
        }
    }

    subjects.sort((a,b) => b.credit - a.credit || a.course.localeCompare(b.course));
    return subjects;
}

module.exports = { legacyParse };
