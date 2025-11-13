🌌 VTOP GPA Calculator — Auto GPA Engine for VIT Students

Paste your VTOP timetable → get an instant, beautiful GPA calculator.
No manual entry. No stress. No VTOP trauma.








💡 What This Project Does

This tool converts the raw VTOP timetable text into a clean GPA calculator.

You literally:

1️⃣ Copy your timetable

(From S.No → last “Registered and Approved”)

2️⃣ Paste it into the tool
3️⃣ Instantly see:

Clean subject names

Extracted credit values

Grouped subjects by credit

Grade dropdowns

Auto GPA calculation

No typing.
No hunting credit numbers.
No coding.
Just vibes.

✨ Core Features
🔹 Smart Parser

Detects course blocks

Extracts LTPC credits (last value)

Removes course codes (BCSE202L)

Keeps clean names

Auto-filters NGCR for GPA

Handles decimal credits (1.5 etc.)

Detects embedded courses (1+2 credits)

🔹 Beautiful UI

Glassmorphism cards

Credit badges

Grouped subject sections

Responsive layout

Looks like a dashboard, not a webpage

🔹 Accurate GPA Engine

Grade dropdowns for each course

Auto weighted GPA

Embedded course logic

Recalculates instantly

🧠 How It Works (Simple Version)

Your timetable contains sections like:

BCSE202L - Data Structures and Algorithms
3 0 0 0 3.0
Discipline Core
...
Registered and Approved


The parser extracts:

Course Name → Data Structures and Algorithms

Credit → 3.0

Category → Discipline Core

Then it:

skips Non-Graded

sorts by credits descending

builds the GPA table

Magic.
Fast.
Accurate.

📂 Project Structure
vtop-gpa-calculator/
│
├── index.html          # Main GPA page
├── styles.css          # Glass UI styles
├── main.js             # Parser + GPA logic
│
├── assets/             # (optional) images/icons
│
├── dashboard/          # Future full dashboard
│   ├── index.html
│   ├── dashboard.css
│   └── dashboard.js
│
└── README.md

🧭 Roadmap
✔ Phase 1 — GPA Tool (Done)

Paste → parse UI

Credit extraction

NGCR filtering

Sorting + grouping

Modern UI

GPA logic

🔜 Phase 2 — Dashboard (Coming Soon)

Personalized greeting

Semester initializer wizard

Save subjects to localStorage

Past semesters list

NGCR credit tracker

CGPA calculator

🔜 Phase 3 — Marks Tracker

CAT / Quiz / Lab marks

Weightage calculator

Remaining marks needed for O/A+

Lost marks indicator

Graphs & progress bars

🔜 Phase 4 — Insights

Difficulty estimate

Performance prediction

Study suggestions

Motivational remarks (“bro you’re fine 😭🔥”)

🛠 Tech Stack

HTML5

CSS3 (Glassmorphism, badges, cards)

Vanilla JavaScript

LocalStorage (future)

GitHub Pages (deployment)

No frameworks.
No dependencies.
Runs everywhere.

🚀 Deployment

Enable GitHub Pages:

Repo → Settings → Pages → Branch: main → /(root)


Then visit:

https://yourusername.github.io/vtop-gpa-calculator/

🧑‍💻 Local Setup
git clone https://github.com/yourusername/vtop-gpa-calculator.git
cd vtop-gpa-calculator


Run locally:

Open index.html in browser

📸 Screenshots (Add later)
[ GPA UI Preview ]

[ Parser Output ]

[ Credits Grouped Layout ]

📜 License

MIT — free to use, modify, evolve.

⭐ Support & Motivation

If this project helped you:

Please leave a ⭐ on GitHub — it keeps the fire alive.

✍️ Author

Raj
A VITian building tools for VITians, one semester at a time.