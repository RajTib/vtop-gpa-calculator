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
- Sorted & grouped subjects by credit  
- A neat GPA calculator UI with grade dropdowns and instant weighted GPA

**Quick:** paste → parse → pick grades → get GPA.


## 🚀 Features

### 📄 Smart Parsing
- Detects course blocks and course codes  
- Extracts credit (last token of LTPC line)  
- Handles decimal credits (e.g. `1.5`)  
- Detects embedded courses (1 + 2 credit pairs)  
- Skips explicit **Non-graded** entries

### 🎨 Modern UI
- Glassy card layout  
- Credit badges and grouped sections  
- Responsive and readable on mobile/desktop

### 🧮 GPA Engine
- Grade dropdown (S, A, B, C, D, E, F)  
- Weighted GPA calculation  
- Instant recalculation on change

## 📁 Project Structure
vtop-gpa-calculator/<br>
├── index.html<br>
├── styles.css<br>
├── main.js<br>
├── assets/<br>
├── dashboard/<br>
|    ├── index.html<br>
|    ├── dashboard.css<br>
|    ├── dashboard.js<br>
└── README.md<br>


## ⚙️ How it works
1. Copy the timetable text from VTOP (from S.No down to Registered and Approved).
2. Paste it into the tool textarea.
3. The parser extracts name, credit, and category for each course.
4. NGCR items are excluded from GPA computation.
5. Results are grouped by credit and the GPA UI is generated automatically.



## 🛠 Tech Stack
- HTML5, CSS3
- Vanilla JavaScript (no frameworks)
- Deploy via GitHub Pages
  

## 🧾 Local Setup

git clone https://github.com/RajTib/vtop-gpa-calculator.git<br>
cd vtop-gpa-calculator<br>
Open index.html in your browser

## 📜 License
This project is released under the MIT License.


## ❤️ Support
If this helps you, a ⭐ on the repo would be appreciated.


## ✍️ Author
Raj — a VITian building tools for VITians.