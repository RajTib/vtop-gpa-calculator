// === Improved parser: robust detection + only exclude Non-graded ===
document.getElementById("parseBtn").onclick = () => {
    const raw = document.getElementById("rawInput").value || "";
    const lines = raw.split("\n").map(l => l.trim()).filter(l => l !== "");

    const subjects = [];
    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 1) Detect course line: try strict code pattern first, else fallback to "something - something"
        if (/^[A-Z]{2,6}\d{3}[A-Z]?\b\s*-\s*/.test(line)) {
            // e.g. "BCSE202L - Data Structures and Algorithms"
            current = {};
            current.course = line.split("-").slice(1).join("-").trim();
            continue;
        }

        // fallback: if line contains " - " and left part has uppercase+digits (looser)
        if (!current && line.includes(" - ")) {
            const left = line.split("-")[0].trim();
            if (/[A-Z]{2,}\d{2,}/.test(left)) {
                current = {};
                current.course = line.split("-").slice(1).join("-").trim();
                continue;
            }
        }

        // 2) If we have a current object, try to pick up LTPC (credits)
        // LTPC lines look like: "3 0 0 0 3.0" or "0 0 3 0 1.5"
        if (current && /(\d+(?:\.\d+)?)(\s+\d+(?:\.\d+)?){4}$/.test(line)) {
            // grab the last numeric token as credit
            const m = line.match(/(\d+(?:\.\d+)?)\s*$/);
            if (m) {
                current.credit = parseFloat(m[1]);
            }
            continue;
        }

        // 3) Category / other descriptive lines (we capture but do NOT strictly filter them out)
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

        // 4) End of course block sign: "Registered and Approved"
        if (current && line.toLowerCase().includes("registered and approved")) {
            // only skip if explicitly non-graded
            const isNonGraded = current.category && /non-graded/i.test(current.category);
            if (!isNonGraded) {
                // Ensure course name exists and a credit number exists; if credit missing, set credit to 0
                if (!current.course) current.course = "Unknown Course";
                if (typeof current.credit === "undefined" || Number.isNaN(current.credit)) {
                    current.credit = 0;
                }
                subjects.push(current);
            }
            current = null;
            continue;
        }

        // 5) Some pages might have course name split across lines:
        //    If current exists but course is empty and this line looks like a human name (no digits),
        //    assume it's the rest of the course name and append.
        if (current && (!current.course || current.course.length < 3) && !/\d/.test(line)) {
            current.course = (current.course ? (current.course + " " + line) : line).trim();
            continue;
        }
    }

    // debug logging
    console.log("Parsed subjects:", subjects);
    subjects.sort((a,b) => b.credit - a.credit || a.course.localeCompare(b.course));
    displaySubjects(subjects);
    showGPARows(subjects);
};


// SHOW SUBJECT LIST ----------------------------------------------------------
function displaySubjects(subjects) {
    const div = document.getElementById("subjects");
    div.innerHTML = "";

    subjects.forEach(sub => {
        const row = document.createElement("div");
        row.className = "subject-row";
        row.innerHTML = `
            <span>${sub.course}</span>
            <span>${sub.credit} credits</span>
        `;
        div.appendChild(row);
    });
}

// SHOW GRADE INPUT ROWS ------------------------------------------------------
function showGPARows(subjects) {
    const div = document.getElementById("gpa-section");
    div.innerHTML = "";

    subjects.forEach(sub => {
        const row = document.createElement("div");
        row.className = "gpa-row";

        row.innerHTML = `
            <input type="text" value="${sub.course}" readonly>
            <input type="number" value="${sub.credit}" readonly>
            <select class="grade">
                <option value="10">S</option>
                <option value="9">A</option>
                <option value="8">B</option>
                <option value="7">C</option>
                <option value="6">D</option>
                <option value="5">E</option>
                <option value="0">F</option>
            </select>
        `;

        div.appendChild(row);
    });
}

// GPA CALCULATION ------------------------------------------------------------
document.getElementById("calcGPA").onclick = () => {
    const rows = document.querySelectorAll(".gpa-row");

    let totalCredits = 0;
    let totalPoints = 0;

    rows.forEach(r => {
        let credit = parseFloat(r.children[1].value);
        let grade = parseFloat(r.querySelector(".grade").value);

        totalCredits += credit;
        totalPoints += credit * grade;
    });

    let gpa = totalPoints / totalCredits;

    document.getElementById("gpaOutput").innerHTML =
        `Your GPA: <span style="color:#4f46e5">${gpa.toFixed(2)}</span>`;
};
