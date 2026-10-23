# 🌌 VTOP GPA Calculator

> **Auto GPA engine for VIT students** — paste your VTOP timetable raw text and get an instant, beautiful GPA calculator.  
> No manual entry. No hunting credits. No suffering.

![Status](https://img.shields.io/badge/Status-Active-brightgreen.svg)
![Version](https://img.shields.io/badge/Version-1.0-blue.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)


## ✨ Overview

This project converts your **raw VTOP timetable text** (from *Sl.No* → last “Registered and Approved”) into:

- Clean subject names (course codes removed)  
- Extracted credit values (C from L T P J C)  
- Filtered non-graded courses (NGCR excluded from GPA)  
- Subjects sorted by credit  
- Semester-wise SGPA, a cumulative CGPA, and predicted vs actual grades, saved in your browser

**Quick:** paste → review courses → pick grades → get SGPA / CGPA.

Your data never leaves your browser: there is no account, no server and no tracking of grades.


## 🚀 Features

### 📄 Smart Parsing
- Detects course blocks and course codes  
- Extracts credit (last token of LTPC line)  
- Handles decimal credits (e.g. `1.5`)  
- Skips explicit **Non-graded** entries and tells you which ones  
- Warns about course blocks it could not read, and never invents a missing credit

### 🎓 Semesters
- Semesters 1–8, each either **ongoing** (predicted grades → projected SGPA) or **completed** (actual grades → actual SGPA)  
- Predictions never touch your actual grades or your actual CGPA; marking a semester completed is an explicit, confirmed step  
- Overall CGPA is credit-weighted across completed semesters  
- Review, edit, add or remove courses before and after saving; duplicate imports are skipped  
- Past semesters can also be stored as just SGPA + credits  
- Export / import a JSON backup; clear data only after confirmation

### 📚 Grade history import
- Paste your whole **VTOP Effective Grades** table (with its header row) into the *Past semesters* card to fill in completed semesters; you review everything before it is saved  
- Columns are found by name: Course Code, Course Title, Course Type, Credits, Grade, Exam Month, Result Declared, Course Distribution  
- Semester numbers come from the exam month: **November = odd, April = even**, in time order (Nov-2024 → 1, Apr-2025 → 2, Nov-2025 → 3, Apr-2026 → 4). Missing semesters stay empty ("Enter data") and later ones are not shifted  
- **NGCR** (Non-Graded Core Requirement, from the *Course Distribution* column) courses are kept in your history but never count toward SGPA, CGPA or credits  
- **Retakes and grade improvements overwrite** the saved course (matched by course code): one record per course, the new grade counts, the old one doesn't  
- Rows that can't be read are listed with the reason, never silently dropped, and import can be undone  
- Details, assumptions and limits: [docs/GPA-RULES.md](docs/GPA-RULES.md)

### 🎨 Modern UI
- Glassy card layout  
- Actual results and projected results are labelled and styled differently  
- Responsive on mobile/desktop

### 🧮 GPA Engine
- Grades S, A, B, C, D, E, F (10, 9, 8, 7, 6, 5, 0)  
- Weighted GPA using integer arithmetic; see [docs/GPA-RULES.md](docs/GPA-RULES.md) for the rules, assumptions and the one rounding difference from the old version

## 📁 Project Structure
vtop-gpa-calculator/<br>
├── index.html<br>
├── styles.css<br>
├── main.js  (UI wiring)<br>
├── js/<br>
|    ├── parser.js  (timetable parsing)<br>
|    ├── history.js  (grade-history parsing, exam period → semester)<br>
|    ├── gpa.js  (SGPA / CGPA maths)<br>
|    ├── model.js  (semesters, validation)<br>
|    ├── storage.js  (localStorage, backup)<br>
├── tests/  (node:test, no dependencies)<br>
├── docs/<br>
├── assets/<br>
├── dashboard/  (empty placeholder)<br>
└── README.md<br>


## ⚙️ How it works
1. Copy the timetable text from VTOP (from S.No down to the last registration status, either `Registered and Approved` or, for retakes, `Registered, Invoice Generated, Fees Paid and Approved`).
2. Paste it into the tool textarea.
3. The parser extracts name, credit, and category for each course.
4. NGCR items are excluded from GPA computation.
5. Review and fix the courses, choose a semester, and save. Grades and results appear on the semester card.
6. Optionally paste your VTOP Effective Grades table into *Past semesters*, review the exam-period → semester mapping and the list of new / updated courses, and import. Retakes overwrite the earlier result.



## 🛠 Tech Stack
- HTML5, CSS3
- Vanilla JavaScript (no frameworks, no build step, no dependencies)
- Hosted on Vercel as a static site
  

## 🧾 Local Setup

git clone https://github.com/RajTib/vtop-gpa-calculator.git<br>
cd vtop-gpa-calculator<br>
Open index.html in your browser (or serve the folder with any static server)

## 🧪 Tests

Requires Node 20+; no install step.

    node --test "tests/*.test.js"

## 📈 Analytics

Not enabled. See [docs/ANALYTICS.md](docs/ANALYTICS.md) for the Cloudflare Web Analytics steps.

## 📜 License
This project is released under the MIT License.


## ❤️ Support
If this helps you, a ⭐ on the repo would be appreciated.


## ✍️ Author
Raj — a VITian building tools for VITians.