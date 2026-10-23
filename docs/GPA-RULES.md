# GPA rules, assumptions and behaviour changes

This documents what the calculator does, where each rule comes from, and what is **assumed rather
than verified**. Nothing here is an official VIT statement; check the official academic regulations
for anything that matters.

## Rules carried over from the original app (unchanged)

| Rule | Source |
|---|---|
| Grade points: S=10, A=9, B=8, C=7, D=6, E=5, F=0 | original `main.js` dropdown |
| GPA = sum(credit x grade points) / sum(credit) | original `main.js` |
| F counts in the denominator with 0 points | original `main.js` (every row was counted) |
| Credit = last number of the `L T P J C` line | original parser |
| Courses whose category line contains "non-graded" are skipped | original parser |

## Assumptions (not verified against official VIT documents)

- The grade table above is complete. **N, P, W and other non-letter grades are not supported**
  (decision: keep the 7 existing grades). A graded course with such a grade is *rejected* by the
  grade-history import and listed in the review, never guessed. The one exception is an NGCR course,
  whose displayed grade (e.g. `P`) is kept for the record only; see "Non-Graded Core Requirements".
- Repeated or improvement courses are handled **only by the grade-history import**, by overwriting
  (see "Retakes and grade improvements"). Courses you add by hand or from a timetable are not
  de-duplicated across semesters: if the same course code is saved in two semesters, both count.
- CGPA = credit-weighted over all counted courses of **completed** semesters, which is the same as
  weighting each semester's SGPA by its counted credits (not a plain average of SGPAs).
- Summary-only semesters (SGPA + credits typed by the user) are weighted by the credits entered.
  They cannot be checked per course.
- "Credits counted" means credits of courses that count toward GPA, have a valid credit and a grade.
  It is not the same as credits *earned* (an F course is counted at 0 points). The UI shows how many
  counted credits are at F.

## Behaviour that differs from the original app

1. **Rounding.** The original used `(points / credits).toFixed(2)` on floats. The new code uses
   integer arithmetic and rounds half up on the exact value. They differ only on exact ties such as
   `164.5 / 20 = 8.225`, where the original printed `8.22` because of floating-point representation and
   the new code prints `8.23`. Whether VIT rounds half up is **unconfirmed**.
2. **Missing credits.** The original silently used 0. A course with no credit found is now flagged and
   left out of the calculation until the user enters one.
3. **Dropped blocks.** The original parser silently dropped a course block that was cut off or never
   closed. The new parser still does not add it, but now tells the user.
4. **Non-graded courses** are still skipped on import, and now listed so the user can see what was skipped.
5. **Default grade** stays S (10), exactly as before. On an ongoing semester this is a prediction; when
   a semester is marked completed, the dialog lists the grades that will become actual.

## Timetable registration status

A course block in the pasted timetable ends at its registration status. Two statuses are recognised:

| Status | Used for |
|---|---|
| `Registered and Approved` | regular registration (original rule, unchanged) |
| `Registered, Invoice Generated, Fees Paid and Approved` | retake / grade-improvement registration |

Case and runs of whitespace (tabs, non-breaking spaces) are ignored. The retake form must contain the
whole phrase; other statuses ("Registered and Waiting", "Fees Not Paid", ...) are not accepted and the
block is reported as not fully read. Only these two strings are known from real VTOP output; any other
status would have to be added deliberately.

## Grade-history import

A second, separate paste (the "Past semesters" card) reads the VTOP Effective Grades table. The
timetable flow is unchanged.

**Format.** Copy the table *including its header row*. Columns are found by header name, so order does
not matter: `Sl.No.`, `Course Code`, `Course Title`, `Course Type`, `Credits`, `Grade`, `Exam Month`,
`Result Declared`, `Course Distribution`, `Detail View`. Required: Course Code, Course Title, Credits,
Grade, Exam Month. Tab-separated text (what the clipboard gives) is the supported format; if tabs were
lost, columns separated by runs of two or more spaces are read too, but a row with an empty cell is then
rejected rather than guessed. Lines before the header are skipped. Page furniture after the table
("Showing 1 to 10 of 10 entries") and repeated headers are listed as *ignored*.

**Nothing is dropped silently.** Every row is either accepted, listed under "Rows that could not be
used" with its line number and reasons (bad code, missing title, credits not a number, unreadable exam
month, unsupported grade, missing grade), or listed as an ignored line. Missing values are never filled
in. Nothing is saved until the student presses Import; the review shows exactly what will happen.

**Not verified.** The parser is tested against a *synthetic* table written from the column list above.
It has not been checked against a real VTOP paste.

## Non-Graded Core Requirements (NGCR)

A course is an NGCR when its `Course Distribution` cell is `NGCR` (or the full phrase "Non-Graded Core
Requirement"). Nothing else decides it: not the grade (`P` on a graded course is not NGCR), the name,
the course type or the credits.

- Kept: code, title, displayed credits, VTOP's grade (stored as `reportedGrade`, e.g. `P`), exam
  month, result date, course type, distribution. Shown in the semester with an "NGCR" badge.
- Never counted: excluded from SGPA, CGPA, projected CGPA and every credit total, even though VTOP
  shows positive credits. The exclusion is in the GPA maths itself (checked before "counts toward
  GPA"), so unticking/ticking cannot change it, editing stored data cannot change it, and an NGCR course
  with no credits or grade never makes a semester "incomplete".
- It has no GPA grade: `actualGrade` and `predictedGrade` stay empty.

## Semester numbers from exam periods

Exam Month is normalised (`Nov-2024`, `NOV 2024`, `November-2024`, `11/2024` and `2024-11` all become
`2024-11`; two-digit years are refused, not guessed). **November is an odd semester and April an even
one**, numbered along the half-year sequence:

| Exam period | Semester |
|---|---:|
| Nov-2024 | 1 |
| Apr-2025 | 2 |
| Nov-2025 | 3 |
| Apr-2026 | 4 |

- Numbering follows time, never the order of rows in the paste. Rows with the same exam period share a
  semester.
- The anchor is the earliest supported period in the paste (November -> Semester 1, April -> Semester 2).
  Once a semester has been imported it remembers its exam period, and later imports are anchored to
  it, so pasting only Nov-2025 later still gives Semester 3.
- **Gaps are kept.** Nov-2024 plus Apr-2026 gives Semesters 1 and 4; Semesters 2 and 3 stay empty slots
  labelled "Enter data".
- **Flagged, not guessed:** any month other than November/April (e.g. May re-exams), and periods that
  would fall outside Semesters 1-8. They are not imported until the student picks a semester for them
  (or chooses to skip them) in the review.
- Never written over: an ongoing semester, a summary-only semester, or a semester that already holds
  another exam period. For an ongoing semester the review offers an explicit, opt-in "move my ongoing
  semester" (e.g. a timetable saved as Semester 1 before the history is imported).

## Retakes and grade improvements (overwrite rule)

Product decision: one counted record per course.

- A course is identified by its course code (normalised: upper case, no spaces), never by title.
- A newer imported result **overwrites the saved record in place**: new grade, credits and metadata
  replace the old ones, the record stays in its semester, and the old grade stops counting. That
  semester's SGPA therefore changes retroactively. The student confirms replacements and can undo.
- "Newer" is decided by exam period. A saved record with no exam period (entered by hand) is compared by
  its semester number instead, using this import's numbering. If numbering from a partial paste looks wrong,
  set the semester for that period in the review.
- An older result never replaces a newer one (it is skipped and explained). Importing the same table
  twice changes nothing.
- Duplicates inside one paste: the latest exam period wins and older attempts are listed as superseded.
  Identical repeated rows are collapsed. The same exam period with different grades is reported as a
  conflict; the later line wins, deterministically.
- If a *newer* row could not be read while an older result was used, a warning says so.
- A course that is also registered in an ongoing semester (a retake in progress) is not imported from
  the older result, so it is not counted twice; it is listed as a pending retake.
- Predicted grades live in a separate field and are never touched by an import.
- The student's own "don't count toward GPA" choice on a course survives an overwrite.
- **Not detectable:** a retake of a course that sits in a summary-only semester (it has no courses), a
  saved course with no code, or the same course saved by hand in two semesters (a warning is shown).
- The timetable review warns when a course is already saved in another completed semester, because a
  retake registered there would be counted twice in the *projected* CGPA until one is removed or unticked.

## Known limitations of the parser (kept for compatibility)

- A non-graded course is only detected if its category line also contains one of: core, elective,
  requirement, sciences, skill, soft. A bare "Non-graded" line is not captured, so that course would be
  imported and counted. The user can untick "Counts toward GPA".
- Parser tests use **synthetic** timetable text. They prove the new parser equals the old one; they do
  not prove either handles every real VTOP layout.

## Manual smoke checklist

1. Open the site with empty storage. Paste a timetable, press **Extract Subjects**: courses, credits and
   skipped non-graded courses look right; nothing is stored yet (DevTools -> Application -> Local Storage).
2. Edit a name, a credit, untick one course, remove one; **Save courses** into a new ongoing semester.
3. Change predicted grades: projected SGPA updates, **Overall CGPA stays "-"**.
4. **Mark as completed**: dialog lists the grades; CGPA now appears and is labelled Actual.
5. Change one actual grade: SGPA and CGPA update.
6. Reload: everything is still there. Open in a second tab: a banner warns after a change.
7. Paste the same timetable again into the same semester: duplicates are reported as skipped.
8. Export backup; Clear all data (confirm); Import the file: same numbers return.
9. Import a hand-broken JSON file: rejected, nothing changes.
10. In DevTools set `localStorage.setItem('vtopGpa.v1','{')` and reload: error banner, app still works,
    original key untouched, a `vtopGpa.v1.corrupt.*` copy exists.
11. Narrow the window to about 360 px: no horizontal scroll, rows stack.
12. Block site data in the browser: banner says nothing will be saved; calculations still work.
