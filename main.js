/*
 * UI wiring. Business logic lives in js/parser.js, js/gpa.js, js/model.js, js/storage.js.
 * All user-supplied text (course names, codes) is written with textContent / DOM properties,
 * never innerHTML, so pasted or imported text can't inject markup.
 */
(function () {
    "use strict";

    var V = window.VtopGpa || {};
    var parser = V.parser, gpa = V.gpa, model = V.model, storage = V.storage;
    var gradeHistory = V.history;   // (not named "history": that is a browser global)
    var $ = function (id) { return document.getElementById(id); };

    if (!parser || !gpa || !model || !storage || !gradeHistory) {
        var msg = document.createElement("div");
        msg.className = "banner error";
        msg.textContent = "The calculator could not load all of its scripts. Please refresh the page.";
        document.body.insertBefore(msg, document.body.firstChild);
        return;
    }

    var store = storage.createStore(function () { return window.localStorage; });
    var state = model.emptyState();
    var selected = 1;          // semester shown in the semester card (not persisted)
    var draft = null;          // timetable extraction awaiting review (not persisted)
    var histDraft = null;      // grade-history paste awaiting review: { parsed, overrides, moveOngoing } (not persisted)
    var semMessage = null;     // { text, kind, undo }

    // ---- tiny DOM helper -------------------------------------------------------------------

    function h(tag, attrs, children) {
        var el = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v === undefined || v === null || v === false) return;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
            else if (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "hidden") el[k] = v;
            else el.setAttribute(k, v === true ? "" : v);
        });
        (children || []).forEach(function (c) {
            if (c === null || c === undefined || c === false) return;
            el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        });
        return el;
    }

    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function pill(text, kind) { return h("span", { class: "pill " + (kind || ""), text: text }); }

    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

    // ---- banners ---------------------------------------------------------------------------

    function setBanner(id, node, kind) {
        var host = $("banners");
        var old = host.querySelector('[data-banner="' + id + '"]');
        if (old) host.removeChild(old);
        if (!node) return;
        var box = h("div", { class: "banner " + (kind || ""), "data-banner": id, role: "status" }, [node]);
        host.appendChild(box);
    }

    function download(filename, text) {
        var blob = new Blob([text], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = h("a", { href: url, download: filename });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function today() { return new Date().toISOString().slice(0, 10); }

    // ---- confirmation dialog (native <dialog>, no window.confirm) --------------------------

    function confirmDialog(opts) {
        return new Promise(function (resolve) {
            var dlg = document.createElement("dialog");
            if (typeof dlg.showModal !== "function") {
                resolve(window.confirm(opts.title + "\n\n" + (opts.plain || "")));
                return;
            }
            dlg.className = "dialog";
            var titleId = "dlg-title-" + Date.now();
            dlg.setAttribute("aria-labelledby", titleId);

            var cancel = h("button", { class: "btn ghost", type: "button", text: opts.cancelLabel || "Cancel",
                onclick: function () { dlg.close("cancel"); } });
            var ok = h("button", { class: "btn " + (opts.danger ? "danger" : "primary"), type: "button",
                text: opts.okLabel || "OK", onclick: function () { dlg.close("ok"); } });

            dlg.appendChild(h("h2", { id: titleId, text: opts.title }));
            dlg.appendChild(h("div", { class: "dialog-body" }, opts.body || []));
            dlg.appendChild(h("div", { class: "button-row" }, [cancel, ok]));

            dlg.addEventListener("close", function () {
                var result = dlg.returnValue === "ok";
                if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
                resolve(result);
            });
            document.body.appendChild(dlg);
            dlg.showModal();
            (opts.danger ? cancel : ok).focus();
        });
    }

    // ---- persistence -----------------------------------------------------------------------

    function persist() {
        var r = store.save(state);
        if (r.ok) { setBanner("save", null); return true; }

        var text = {
            quota: "Your browser's storage is full, so your latest changes are not saved. Export a backup to keep them.",
            blocked: "Saving is paused because older saved data could not be read or preserved. Download it below, then start fresh.",
            unavailable: "Your browser is blocking local storage, so nothing is being saved. You can keep calculating, and Export backup still works."
        }[r.reason] || "Your latest changes could not be saved.";
        setBanner("save", h("p", { text: text }), "warn");
        return false;
    }

    function commit(result) {
        if (!result || result.error) {
            showSemMessage(result ? result.error : "Something went wrong.", "error");
            return false;
        }
        state = result.state;
        persist();
        return true;
    }

    // ---- messages inside the semester card ---------------------------------------------------

    function showSemMessage(text, kind, undo) {
        semMessage = { text: text, kind: kind || "", undo: undo || null };
        renderSemMessage();
    }

    function renderSemMessage() {
        var host = $("semMsg");
        if (!host) return;
        clear(host);
        if (!semMessage) return;
        var m = semMessage;
        var box = h("div", { class: "msg " + m.kind, role: m.kind === "error" ? "alert" : "status" }, [m.text]);
        if (m.undo) {
            box.appendChild(h("button", { class: "btn ghost small", type: "button", text: "Undo", onclick: function () {
                semMessage = null;
                m.undo();
            } }));
        }
        host.appendChild(box);
    }

    // ---- step 1 & 2: extraction and review ---------------------------------------------------

    function setParseMessage(text, kind) {
        var host = $("parseMessages");
        clear(host);
        if (text) host.appendChild(h("div", { class: "msg " + (kind || "") }, [text]));
    }

    $("parseBtn").addEventListener("click", function () {
        var raw = $("rawInput").value || "";
        if (!raw.trim()) {
            setParseMessage("Paste your timetable text first.", "error");
            return;
        }
        var result = parser.parseTimetable(raw);
        if (!result.subjects.length) {
            draft = null;
            $("subjectsCard").hidden = true;
            setParseMessage("No courses were found. Copy everything from the S.No. line down to the last " +
                "registration status line (for example “Registered and Approved”) and paste it again.", "error");
            return;
        }
        setParseMessage("");
        draft = {
            skipped: result.skipped,
            warnings: result.warnings,
            rows: result.subjects.map(function (s) {
                return {
                    code: s.code || "",
                    name: s.course,
                    creditsText: s.creditMissing ? "" : String(s.credit),
                    creditMissing: !!s.creditMissing,
                    countsToGpa: true
                };
            })
        };
        renderReview();
        $("subjectsCard").hidden = false;
        $("subjectsCard").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("discardDraftBtn").addEventListener("click", function () {
        draft = null;
        $("subjectsCard").hidden = true;
    });

    function defaultTarget() {
        if (state.currentSemester) return state.currentSemester;
        var free = model.firstFreeNumber(state);
        return free || selected;
    }

    function renderReview() {
        if (!draft) return;
        var notes = $("reviewNotes");
        clear(notes);

        if (draft.skipped.length) {
            notes.appendChild(h("div", { class: "msg" }, [
                "Skipped as non-graded (not added): ",
                draft.skipped.map(function (s) { return (s.code ? s.code + " – " : "") + s.course; }).join("; ") +
                ". If one of these should count toward GPA, add it manually afterwards."
            ]));
        }
        draft.warnings.forEach(function (w) {
            notes.appendChild(h("div", { class: "msg warn" }, [
                "Could not fully read “" + w.course + "” (its block was cut off or never closed). " +
                "It was not added – check that you pasted up to its “Registered and Approved” line."
            ]));
        });

        var target = $("targetSemester");
        var previous = target.value ? Number(target.value) : defaultTarget();
        clear(target);
        for (var n = 1; n <= model.MAX_SEMESTER; n++) {
            var sem = model.getSemester(state, n);
            var label = "Semester " + n + (sem ? " (" + (sem.status === "completed" ? "completed" : "ongoing") +
                (sem.kind === "summary" ? ", summary only" : "") + ")" : " (new)");
            target.appendChild(h("option", { value: String(n), text: label, selected: n === previous }));
        }
        target.onchange = refreshReview;
        refreshReview();
    }

    // Completed semesters (other than `except`) that already hold a course with this code.
    function savedElsewhere(code, except) {
        var wanted = gradeHistory.normalizeCode(code);
        if (!wanted) return [];
        return state.semesters.filter(function (s) {
            return s.number !== except && s.kind === "courses" && s.status === "completed" &&
                s.courses.some(function (c) { return gradeHistory.normalizeCode(c.code) === wanted; });
        }).map(function (s) { return s.number; });
    }

    function refreshReview() {
        if (!draft) return;
        var n = Number($("targetSemester").value);
        var sem = model.getSemester(state, n);
        var statusSel = $("targetStatus");
        statusSel.disabled = !!sem;
        if (sem) statusSel.value = sem.status;

        var existingKeys = {};
        if (sem) sem.courses.forEach(function (c) { existingKeys[model.courseKey(c)] = true; });

        var host = $("subjects");
        clear(host);
        draft.rows.forEach(function (row, i) {
            var notes = h("div", { class: "notes" });
            function refreshNotes() {
                clear(notes);
                if (row.code) notes.appendChild(pill(row.code, "info"));
                var credit = row.creditsText.trim();
                if (credit === "") notes.appendChild(pill("Credits not found – enter them or it won't count", "warn"));
                if (existingKeys[model.courseKey({ code: row.code, name: row.name })]) {
                    notes.appendChild(pill("Already in Semester " + n + " – will be skipped", "warn"));
                }
                var earlier = savedElsewhere(row.code, n);
                if (earlier.length) {
                    notes.appendChild(pill("Also saved in Semester " + earlier.join(", ") + " – counted twice in the projected CGPA until you remove or untick one", "warn"));
                }
            }

            var nameInput = h("input", { type: "text", value: row.name, "aria-label": "Course name", maxlength: String(model.MAX_NAME) });
            nameInput.addEventListener("input", function () { row.name = nameInput.value; refreshNotes(); });
            var creditInput = h("input", { type: "number", value: row.creditsText, "aria-label": "Credits for " + row.name,
                min: "0", max: String(gpa.MAX_COURSE_CREDITS), step: "0.5", placeholder: "?" });
            creditInput.addEventListener("input", function () { row.creditsText = creditInput.value; refreshNotes(); });
            var counts = h("input", { type: "checkbox", checked: row.countsToGpa, "aria-label": "Counts toward GPA: " + row.name });
            counts.addEventListener("change", function () { row.countsToGpa = counts.checked; });

            refreshNotes();
            host.appendChild(h("div", { class: "review-row" }, [
                nameInput,
                creditInput,
                h("label", { class: "check" }, [counts, "Counts toward GPA"]),
                h("button", { class: "icon-btn", type: "button", "aria-label": "Remove " + row.name, text: "✕", onclick: function () {
                    draft.rows.splice(i, 1);
                    if (!draft.rows.length) { draft = null; $("subjectsCard").hidden = true; return; }
                    refreshReview();
                } }),
                notes
            ]));
        });
    }

    $("saveDraftBtn").addEventListener("click", function () {
        if (!draft) return;
        var n = Number($("targetSemester").value);
        var incoming = [];
        for (var i = 0; i < draft.rows.length; i++) {
            var row = draft.rows[i];
            var name = row.name.trim();
            if (!name) { setReviewError("Course " + (i + 1) + " has no name. Fill it in or remove it."); return; }
            var text = row.creditsText.trim();
            var credits = null;
            if (text !== "") {
                credits = Number(text);
                if (gpa.creditsToInt(credits) === null) {
                    setReviewError("“" + name + "”: credits must be a number from 0 to " + gpa.MAX_COURSE_CREDITS + " with at most 2 decimals.");
                    return;
                }
            }
            incoming.push({ code: row.code, name: name, credits: credits, countsToGpa: row.countsToGpa });
        }

        var s = state;
        if (!model.getSemester(s, n)) {
            var created = model.createSemester(s, n, { status: $("targetStatus").value });
            if (created.error) { setReviewError(created.error); return; }
            s = created.state;
        }
        var res = model.addCourses(s, n, incoming);
        if (res.error) { setReviewError(res.error); return; }

        state = res.state;
        persist();
        selected = n;
        draft = null;
        $("subjectsCard").hidden = true;
        $("rawInput").value = "";

        var parts = ["Added " + plural(res.added.length, "course", "courses") + " to Semester " + n + "."];
        if (res.duplicates.length) parts.push(plural(res.duplicates.length, "course was", "courses were") + " already there and skipped.");
        if (res.rejected.length) parts.push(res.rejected.map(function (r) { return "“" + r.name + "” not added (" + r.reason + ")"; }).join("; ") + ".");
        semMessage = { text: parts.join(" "), kind: res.rejected.length ? "warn" : "ok" };
        renderAll();
        $("semesterCard").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    function setReviewError(text) {
        var notes = $("reviewNotes");
        var old = notes.querySelector("[data-save-error]");
        if (old) notes.removeChild(old);
        notes.appendChild(h("div", { class: "msg error", role: "alert", "data-save-error": "1" }, [text]));
    }

    // ---- grade-history import --------------------------------------------------------------
    // Reads a pasted VTOP grade table and shows what would happen. The plan comes from the model
    // (model.planHistoryImport), so what the review shows is what Import does. Nothing is saved
    // until the student confirms, and the import itself runs through model.applyHistoryImport.

    var PERIOD_STATUS = {
        "new": ["New semester", "actual"],
        existing: ["Adds to your saved semester", "info"],
        blocked: ["Can't import here", "warn"],
        unassigned: ["Needs a semester", "warn"],
        skipped: ["Skipped", "info"]
    };

    function setHistoryMessage(text, kind) {
        var host = $("historyMessages");
        clear(host);
        if (text) host.appendChild(h("div", { class: "msg " + (kind || ""), role: kind === "error" ? "alert" : "status" }, [text]));
    }

    function closeHistoryReview() {
        histDraft = null;
        $("historyReviewCard").hidden = true;
        clear($("historyReview"));
    }

    function histOptions() {
        return { periodOverrides: histDraft.overrides, moveOngoing: histDraft.moveOngoing };
    }

    function gradeText(g) { return g ? g : "no grade"; }

    function creditText(c) { return c === null || c === undefined ? "credits unknown" : c + " cr"; }

    $("historyParseBtn").addEventListener("click", function () {
        var raw = $("historyInput").value || "";
        if (!raw.trim()) { setHistoryMessage("Paste your grade table first.", "error"); return; }
        var parsed = gradeHistory.parseGradeHistory(raw);
        if (parsed.error) { closeHistoryReview(); setHistoryMessage(parsed.error, "error"); return; }
        if (!parsed.rows.length && !parsed.rejected.length) {
            closeHistoryReview();
            setHistoryMessage("The table header was found, but no course rows were read below it.", "error");
            return;
        }
        setHistoryMessage("");
        histDraft = { parsed: parsed, overrides: {}, moveOngoing: false };
        renderHistoryReview();
        $("historyReviewCard").hidden = false;
        $("historyReviewCard").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("historyDiscardBtn").addEventListener("click", closeHistoryReview);

    function buildPeriodRow(p) {
        var select = h("select", { "aria-label": "Semester for " + p.label, "data-focus-id": "p:" + p.key });
        if (p.semester === null && p.status !== "skipped") select.appendChild(h("option", { value: "", text: "Choose a semester…", selected: true }));
        select.appendChild(h("option", { value: "none", text: "Don't import this period", selected: p.status === "skipped" }));
        for (var n = 1; n <= model.MAX_SEMESTER; n++) {
            select.appendChild(h("option", { value: String(n), selected: n === p.semester,
                text: "Semester " + n + (p.auto && n === p.semester ? " (from the exam month)" : "") }));
        }
        select.addEventListener("change", function () {
            if (select.value === "") delete histDraft.overrides[p.key];
            else histDraft.overrides[p.key] = select.value;
            renderHistoryReview();
        });
        var st = PERIOD_STATUS[p.status] || [p.status, ""];
        var row = h("div", { class: "hist-period" }, [
            h("div", {}, [h("strong", { text: p.label }), " · " + plural(p.rows, "row", "rows")]),
            select,
            h("div", {}, [pill(st[0], st[1])])
        ]);
        if (p.reason) row.appendChild(h("div", { class: "reason", text: p.reason }));
        return row;
    }

    function buildItemRow(item) {
        var r = item.row;
        var result = (r.ngcr ? "VTOP shows " + gradeText(r.grade) : "Grade " + gradeText(r.grade)) + " · " + creditText(r.credits) + " · " + r.periodLabel;
        var action;
        if (item.action === "add") action = pill("New · Semester " + item.semester, "actual");
        else if (item.action === "overwrite") {
            action = pill("Updates Semester " + item.semester + ": " + gradeText(item.before.grade) + " → " + gradeText(r.grade), "projected");
        } else if (item.action === "unchanged") action = pill("Already saved", "info");
        else action = pill("Not imported", "warn");

        var title = h("div", {}, [
            h("div", { class: "title", text: item.title }),
            h("div", { class: "meta", text: item.code }),
            r.ngcr ? pill("NGCR · not counted in GPA", "info") : null
        ]);
        var row = h("div", { class: "hist-item " + item.action }, [title, h("div", { text: result }), h("div", {}, [action])]);
        if (item.action !== "add" && item.reason) row.appendChild(h("div", { class: "reason", text: item.reason }));
        return row;
    }

    function historyList(heading, nodes, open) {
        if (!nodes.length) return null;
        var box = h("details", { class: "hist-section", open: open ? "" : null }, [
            h("summary", { text: heading + " (" + nodes.length + ")" }),
            h("ul", { class: "hist-list" }, nodes)
        ]);
        return box;
    }

    function renderHistoryReview() {
        if (!histDraft) return;
        var host = $("historyReview");
        var active = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-focus-id");
        var plan = model.planHistoryImport(state, histDraft.parsed, histOptions());
        clear(host);
        var importBtn = $("historyImportBtn");

        if (plan.error) {
            host.appendChild(h("div", { class: "msg error", role: "alert" }, [plan.error]));
            importBtn.disabled = true;
            return;
        }

        var c = plan.counts;
        host.appendChild(h("p", { class: "hist-summary" }, [
            "Read " + plural(histDraft.parsed.rows.length, "course", "courses") + " in " + plural(plan.periods.length, "exam period", "exam periods") + ": " +
            c.add + " new, " + c.overwrite + " to update, " + c.unchanged + " already saved, " + c.skip + " not imported" +
            (c.rejected ? ", " + plural(c.rejected, "row", "rows") + " could not be read" : "") + "."
        ]));
        if (plan.anchor) {
            host.appendChild(h("p", { class: "hint", text: "Semesters are counted from " + plan.anchor.label + " = Semester " + plan.anchor.semester +
                (plan.anchor.source === "saved" ? " (taken from your saved semesters)." : " (the earliest exam period in this table).") +
                " A missing semester stays empty; later ones are not shifted." }));
        }

        host.appendChild(h("div", { class: "hist-section" }, [h("h3", { text: "Exam periods" })].concat(plan.periods.map(buildPeriodRow))));

        if (plan.ongoingMoves.length) {
            var box = h("input", { type: "checkbox", checked: histDraft.moveOngoing, "data-focus-id": "move" });
            box.addEventListener("change", function () { histDraft.moveOngoing = box.checked; renderHistoryReview(); });
            host.appendChild(h("div", { class: "msg warn" }, [h("label", { class: "check hist-move" }, [box,
                "Move my ongoing semester (" + plan.ongoingMoves.map(function (m) { return "Semester " + m.from + " → Semester " + m.to; }).join(", ") +
                ") so its number is free for your history. Its courses and predictions are kept."])]));
        }

        var items = plan.items.slice().sort(function (a, b) {
            return (a.semester === null) - (b.semester === null) || a.semester - b.semester || (a.code < b.code ? -1 : 1);
        });
        host.appendChild(h("div", { class: "hist-section" }, [h("h3", { text: "Courses" })].concat(items.map(buildItemRow))));

        var problems = [
            historyList("Rows that could not be used", plan.rejected.map(function (r) {
                return h("li", {}, ["Line " + r.line + ": " + r.reasons.join("; "), h("div", { class: "hist-raw", text: r.text })]);
            }), true),
            historyList("Conflicting results in the same exam period", plan.conflicts.map(function (x) {
                return h("li", { text: x.code + ": kept " + gradeText(x.kept.grade) + " (line " + x.kept.line + "), dropped " + gradeText(x.dropped.grade) +
                    " (line " + x.dropped.line + "). Check which one is right." });
            }), true),
            historyList("Older attempts and repeated rows", plan.superseded.filter(function (x) { return x.kind !== "conflict"; }).map(function (x) {
                return h("li", { text: x.code + ": " + (x.kind === "duplicate" ? "repeated row ignored"
                    : gradeText(x.dropped.grade) + " (" + x.dropped.periodLabel + ") replaced by " + gradeText(x.kept.grade) + " (" + x.kept.periodLabel + ")") });
            }), false),
            historyList("Warnings", plan.warnings.map(function (w) { return h("li", { text: w }); }), true),
            historyList("Lines ignored", plan.ignored.map(function (i) {
                return h("li", {}, [i.reason + " (line " + i.line + ")", h("div", { class: "hist-raw", text: i.text })]);
            }), false)
        ];
        problems.forEach(function (p) { if (p) host.appendChild(p); });

        var changes = c.add + c.overwrite;
        importBtn.disabled = !plan.importable;
        importBtn.textContent = plan.importable ? "Import " + plural(changes, "course", "courses") : "Nothing to import";

        if (active) {
            var again = host.querySelector('[data-focus-id="' + active.replace(/"/g, "") + '"]');
            if (again) again.focus();
        }
    }

    function setHistoryReviewError(text) {
        var host = $("historyReview");
        var old = host.querySelector("[data-save-error]");
        if (old) host.removeChild(old);
        host.insertBefore(h("div", { class: "msg error", role: "alert", "data-save-error": "1" }, [text]), host.firstChild);
    }

    $("historyImportBtn").addEventListener("click", async function () {
        if (!histDraft) return;
        var opts = histOptions();
        var plan = model.planHistoryImport(state, histDraft.parsed, opts);
        if (plan.error || !plan.importable) return;

        // Replacing saved results (a retake) or moving a semester always asks first.
        var replaced = plan.items.filter(function (i) { return i.action === "overwrite"; });
        var moves = plan.ongoingMoves.filter(function (m) { return m.applied; });
        if (replaced.length || moves.length) {
            var body = [];
            if (replaced.length) {
                body.push(h("p", { text: "These saved courses are replaced by the newer result (the old grade stops counting):" }));
                body.push(h("ul", {}, replaced.map(function (i) {
                    return h("li", { text: i.code + " " + i.title + ": " + gradeText(i.before.grade) + " → " + gradeText(i.row.grade) + " (stays in Semester " + i.semester + ")" });
                })));
            }
            if (moves.length) {
                body.push(h("p", { text: moves.map(function (m) { return "Your ongoing Semester " + m.from + " moves to Semester " + m.to + "."; }).join(" ") }));
            }
            body.push(h("p", { text: "You can undo the import right afterwards." }));
            var go = await confirmDialog({ title: replaced.length ? "Import and replace saved results?" : "Import and move your ongoing semester?",
                body: body, okLabel: "Import",
                plain: replaced.length ? "Some saved courses will be replaced by newer results." : "Your ongoing semester will be moved to a new number." });
            if (!go) return;
        }

        var before = state;
        var res = model.applyHistoryImport(state, histDraft.parsed, opts);     // re-planned from the current data
        if (res.error) { setHistoryReviewError(res.error); return; }
        if (!commit(res)) return;

        var counts = res.plan.counts;
        var touched = res.plan.items.filter(function (i) { return i.action === "add" || i.action === "overwrite"; })
            .map(function (i) { return i.semester; });
        selected = touched.length ? Math.min.apply(null, touched) : selected;
        closeHistoryReview();
        $("historyInput").value = "";
        setHistoryMessage("");

        var parts = ["Imported " + plural(counts.add, "new course", "new courses") +
            (counts.overwrite ? " and updated " + plural(counts.overwrite, "course", "courses") : "") + "."];
        if (counts.skip) parts.push(plural(counts.skip, "course was", "courses were") + " not imported.");
        if (counts.rejected) parts.push(plural(counts.rejected, "row", "rows") + " could not be read.");
        semMessage = { text: parts.join(" "), kind: counts.skip || counts.rejected ? "warn" : "ok", undo: function () {
            state = before;
            persist();
            renderAll();
        } };
        renderAll();
        $("semesterCard").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // ---- dashboard -------------------------------------------------------------------------

    function resultLabel(r) { return r.basis === "actual" ? "Actual" : "Projected"; }

    function renderTiles() {
        var host = $("tiles");
        clear(host);

        var cg = gpa.computeCgpa(state.semesters);
        var cgSub;
        if (!cg.semesters.length) {
            cgSub = "Mark a semester as completed to see your actual CGPA.";
        } else {
            cgSub = plural(cg.semesters.length, "completed semester", "completed semesters") + " · " +
                gpa.formatCredits(cg.credits100) + " credits counted";
            if (cg.summaryOnlyCount) cgSub += " · " + plural(cg.summaryOnlyCount, "summary-only semester", "summary-only semesters");
        }
        var cgTile = h("div", { class: "tile actual" }, [
            h("h3", {}, ["Overall CGPA", pill("Actual", "actual")]),
            h("div", { class: "big-number", text: cg.display }),
            h("div", { class: "sub", text: cgSub })
        ]);
        if (cg.status === "incomplete") {
            cgTile.appendChild(h("div", { class: "sub" }, [pill("Incomplete", "warn"), " Semester " +
                cg.incompleteSemesters.join(", ") + " has courses missing a credit or grade."]));
        }
        host.appendChild(cgTile);

        var cur = state.currentSemester ? model.getSemester(state, state.currentSemester) : null;
        if (cur) {
            var r = gpa.computeSemester(cur);
            host.appendChild(h("div", { class: "tile projected" }, [
                h("h3", {}, ["Semester " + cur.number + " (current)", pill("Projected", "projected")]),
                h("div", { class: "big-number", text: r.display }),
                h("div", { class: "sub", text: r.credits100 ? "Projected SGPA · " + gpa.formatCredits(r.credits100) + " credits counted" : "Add courses to see a projected SGPA." })
            ]));
        } else {
            host.appendChild(h("div", { class: "tile" }, [
                h("h3", { text: "Current semester" }),
                h("div", { class: "big-number", text: "—" }),
                h("div", { class: "sub", text: "No ongoing semester. Paste a timetable above to start one." })
            ]));
        }

        var hasOngoing = state.semesters.some(function (s) {
            return s.status === "ongoing" && gpa.computeSemester(s).credits100 > 0;
        });
        if (hasOngoing) {
            var pcg = gpa.computeCgpa(state.semesters, { includeOngoing: true });
            host.appendChild(h("div", { class: "tile projected" }, [
                h("h3", {}, ["CGPA if predictions hold", pill("Projected", "projected")]),
                h("div", { class: "big-number", text: pcg.display }),
                h("div", { class: "sub", text: "Completed semesters plus your predicted grades. Not part of your actual CGPA." })
            ]));
        }
    }

    function renderNav() {
        var host = $("semNav");
        clear(host);
        for (var n = 1; n <= model.MAX_SEMESTER; n++) {
            (function (n) {
                var sem = model.getSemester(state, n);
                var sub = "Enter data", cls = "sem-btn", aria = "Semester " + n + ", no data yet, enter data";
                if (sem) {
                    var r = gpa.computeSemester(sem);
                    var kind = resultLabel(r);
                    sub = kind + " " + r.display;
                    cls += " " + sem.status;
                    aria = "Semester " + n + ", " + sem.status + ", " + kind.toLowerCase() + " SGPA " + r.display +
                        (state.currentSemester === n ? ", current" : "");
                }
                var btn = h("button", { class: cls, type: "button", "aria-label": aria,
                    "aria-current": n === selected ? "true" : null, onclick: function () {
                        selected = n;
                        semMessage = null;
                        renderAll();
                    } }, [
                    h("span", { class: "sem-name", text: "Sem " + n + (state.currentSemester === n ? " ★" : "") }),
                    h("span", { class: "sem-sub", text: sub })
                ]);
                host.appendChild(h("li", {}, [btn]));
            })(n);
        }
    }

    // ---- step 3: semester card -------------------------------------------------------------

    var REASONS = {
        "non-gpa": "doesn't count toward GPA",
        "ngcr": "non-graded core requirement, kept for your record",
        "no-credit": "credits missing",
        "no-grade": "no grade",
        "zero-credit": "0 credits"
    };

    function buildResultBlock(sem) {
        var r = gpa.computeSemester(sem);
        var label = r.basis === "actual" ? "Actual SGPA" : "Projected SGPA";
        var box = h("div", { class: "result-block " + r.basis, "aria-live": "polite", id: "resultBlock" });

        box.appendChild(h("div", { class: "label" }, [label, pill(resultLabel(r), r.basis)]));
        box.appendChild(h("div", { class: "value", text: r.display }));

        if (r.status === "empty") {
            box.appendChild(h("div", { class: "detail", text: "Nothing to calculate yet – no course has both credits and a grade." }));
        } else {
            var detail = "Based on " + gpa.formatCredits(r.credits100) + " credits · " + gpa.formatPoints(r.points100) + " grade points";
            if (r.summaryOnly) detail = "Based on the SGPA and " + gpa.formatCredits(r.credits100) + " credits you entered";
            if (r.failedCredits100) detail += " · includes " + gpa.formatCredits(r.failedCredits100) + " credits at F";
            box.appendChild(h("div", { class: "detail", text: detail }));
        }
        if (r.status === "incomplete") {
            box.appendChild(h("div", { class: "detail" }, [pill("Incomplete", "warn"), " Some courses are missing information, so they are left out."]));
        }
        if (r.excluded.length) {
            var items = r.excluded.map(function (e) {
                return h("li", { text: e.name + " – " + (REASONS[e.reason] || e.reason) });
            });
            box.appendChild(h("div", { class: "excluded" }, ["Not counted:", h("ul", {}, items)]));
        }
        return box;
    }

    function gradeSelect(value, label, onChange) {
        var sel = h("select", { "aria-label": label });
        if (value === null) sel.appendChild(h("option", { value: "", text: "—", selected: true }));
        gpa.GRADES.forEach(function (g) {
            sel.appendChild(h("option", { value: g, text: g + " (" + gpa.GRADE_POINTS[g] + ")", selected: g === value }));
        });
        sel.addEventListener("change", function () { if (sel.value) onChange(sel.value); });
        return sel;
    }

    function updateCourseField(sem, course, patch, revert) {
        var res = model.updateCourse(state, sem.number, course.id, patch);
        if (res.error) {
            revert();
            showSemMessage(res.error, "error");
            return;
        }
        state = res.state;
        persist();
        semMessage = null;
        renderSemMessage();
        refreshLive();
    }

    // Re-render everything that shows results, without rebuilding the course inputs (keeps focus).
    function refreshLive() {
        renderTiles();
        renderNav();
        var sem = model.getSemester(state, selected);
        var old = $("resultBlock");
        if (sem && old) old.parentNode.replaceChild(buildResultBlock(sem), old);
        if (sem) {
            var rowsHost = $("courseRows");
            if (rowsHost) {
                var excludedIds = {};
                gpa.computeSemester(sem).excluded.forEach(function (e) { excludedIds[e.id] = true; });
                Array.prototype.forEach.call(rowsHost.children, function (row) {
                    row.classList.toggle("excluded", !!excludedIds[row.getAttribute("data-id")]);
                });
            }
        }
    }

    function findCourse(number, id) {
        var sem = model.getSemester(state, number);
        if (!sem) return null;
        for (var i = 0; i < sem.courses.length; i++) if (sem.courses[i].id === id) return sem.courses[i];
        return null;
    }

    function buildCourseRow(sem, course) {
        var isCompleted = sem.status === "completed";
        var gradeKey = isCompleted ? "actualGrade" : "predictedGrade";

        // `course` is re-read from the current state after every edit so reverts show the saved value.
        function edit(patch, revert) {
            updateCourseField(sem, course, patch, revert);
            course = findCourse(sem.number, course.id) || course;
        }

        var nameInput = h("input", { type: "text", value: course.name, "aria-label": "Course name", maxlength: String(model.MAX_NAME) });
        nameInput.addEventListener("change", function () {
            edit({ name: nameInput.value }, function () { nameInput.value = course.name; });
        });

        var creditInput = h("input", { type: "number", value: course.credits === null ? "" : String(course.credits),
            "aria-label": "Credits for " + course.name, min: "0", max: String(gpa.MAX_COURSE_CREDITS), step: "0.5", placeholder: "?" });
        creditInput.addEventListener("change", function () {
            var txt = creditInput.value.trim();
            edit({ credits: txt === "" ? null : Number(txt) }, function () {
                creditInput.value = course.credits === null ? "" : String(course.credits);
            });
        });

        // A Non-Graded Core Requirement is shown for the record only: no grade menu, and the
        // "counts" box is locked off (the model and the GPA maths refuse it as well).
        var ngcr = gpa.isNgcr(course);

        var counts = h("input", { type: "checkbox", checked: ngcr ? false : course.countsToGpa, disabled: ngcr,
            "aria-label": ngcr ? "Never counts toward GPA (non-graded): " + course.name : "Counts toward GPA: " + course.name });
        counts.addEventListener("change", function () {
            edit({ countsToGpa: counts.checked }, function () { counts.checked = course.countsToGpa; });
        });

        var grade = ngcr
            ? h("div", { class: "ngcr-note" }, [
                pill("NGCR", "info"),
                (course.reportedGrade ? "VTOP shows " + course.reportedGrade + ". " : "") + "Non-graded: not counted in GPA"
            ])
            : gradeSelect(course[gradeKey], (isCompleted ? "Actual grade for " : "Predicted grade for ") + course.name, function (g) {
                var patch = {};
                patch[gradeKey] = g;
                edit(patch, function () {});
            });

        var remove = h("button", { class: "icon-btn", type: "button", "aria-label": "Remove " + course.name, text: "✕", onclick: function () {
            var before = state;
            var removedName = course.name;
            if (!commit(model.removeCourse(state, sem.number, course.id))) return;
            renderAll();
            showSemMessage("Removed “" + removedName + "”.", "", function () {
                state = before;
                persist();
                renderAll();
            });
        } });

        var row = h("div", { class: "course-row" + (ngcr ? " ngcr" : ""), "data-id": course.id }, [
            h("div", { class: "name-cell" }, [h("span", { class: "field-label", text: "Course" }), nameInput]),
            h("div", {}, [h("span", { class: "field-label", text: "Credits" }), creditInput]),
            h("label", { class: "check" }, [counts, "Counts"]),
            h("div", {}, [h("span", { class: "field-label", text: ngcr ? "Grade" : isCompleted ? "Actual grade" : "Predicted grade" }), grade]),
            h("div", { class: "remove-cell" }, [remove])
        ]);
        var meta = courseMeta(course);
        if (meta) row.appendChild(h("div", { class: "code", text: meta }));
        return row;
    }

    // "BCSE202L · Theory Only · PC · Exam Apr-2025 · Result declared 20-May-2025" (only what is known)
    function courseMeta(course) {
        var parts = [];
        if (course.code) parts.push(course.code);
        if (course.courseType) parts.push(course.courseType);
        if (course.distribution) parts.push(course.distribution);
        if (course.examPeriod) {
            var p = gradeHistory.normalizePeriod(course.examPeriod);
            parts.push("Exam " + (p.ok ? p.label : course.examPeriod));
        }
        if (course.resultDeclared) parts.push("Result declared " + course.resultDeclared);
        return parts.join(" · ");
    }

    function parseNumberField(input) {
        var txt = input.value.trim();
        return txt === "" ? null : Number(txt);
    }

    function renderSemester() {
        var host = $("semesterBody");
        clear(host);
        var sem = model.getSemester(state, selected);

        host.appendChild(h("div", { id: "semMsg", class: "messages" }));

        if (!sem) {
            host.appendChild(h("div", { class: "empty-state" }, [
                h("p", { text: "Semester " + selected + " has no data yet." }),
                h("p", { text: "Paste your timetable or your grade history above to import its courses, or start it by hand:" }),
                h("div", { class: "button-row" }, [
                    h("button", { class: "btn ghost", type: "button", text: "Add as ongoing", onclick: function () { createSem({ status: "ongoing" }); } }),
                    h("button", { class: "btn ghost", type: "button", text: "Add as completed", onclick: function () { createSem({ status: "completed" }); } }),
                    h("button", { class: "btn ghost", type: "button", text: "Completed – SGPA & credits only", onclick: function () { createSem({ status: "completed", kind: "summary" }); } })
                ])
            ]));
            renderSemMessage();
            return;
        }

        var isCompleted = sem.status === "completed";
        host.appendChild(h("div", { class: "sem-header" }, [
            h("h3", { text: "Semester " + sem.number }),
            pill(isCompleted ? "Completed" : "Ongoing", isCompleted ? "actual" : "projected"),
            sem.kind === "summary" ? pill("Summary only", "info") : null,
            sem.examPeriod ? pill("Exam period " + (gradeHistory.normalizePeriod(sem.examPeriod).label || sem.examPeriod), "info") : null,
            !isCompleted && state.currentSemester === sem.number ? pill("Current", "info") : null
        ]));

        var actions = h("div", { class: "sem-actions" });
        if (!isCompleted) {
            actions.appendChild(h("button", { class: "btn primary small", type: "button", text: "Mark as completed", onclick: function () { markCompleted(sem); } }));
            if (state.currentSemester !== sem.number) {
                actions.appendChild(h("button", { class: "btn ghost small", type: "button", text: "Make current", onclick: function () {
                    if (commit(model.setCurrent(state, sem.number))) renderAll();
                } }));
            }
        } else if (sem.kind === "courses") {
            actions.appendChild(h("button", { class: "btn ghost small", type: "button", text: "Reopen as ongoing", onclick: function () { reopen(sem); } }));
        }
        actions.appendChild(h("button", { class: "btn danger small", type: "button", text: "Delete semester", onclick: function () { deleteSem(sem); } }));
        host.appendChild(actions);

        if (sem.kind === "summary") {
            var credits = h("input", { type: "number", min: "0", max: String(gpa.MAX_COURSE_CREDITS), step: "0.5",
                value: sem.summary.credits === null ? "" : String(sem.summary.credits), "aria-label": "Credits counted in this semester's SGPA" });
            var sgpa = h("input", { type: "number", min: "0", max: "10", step: "0.01",
                value: sem.summary.sgpa === null ? "" : String(sem.summary.sgpa), "aria-label": "SGPA" });
            var saveSummary = function () {
                var res = model.setSummary(state, sem.number, { credits: parseNumberField(credits), sgpa: parseNumberField(sgpa) });
                if (res.error) {
                    showSemMessage(res.error, "error");
                    return;
                }
                state = res.state;
                persist();
                semMessage = null;
                renderSemMessage();
                refreshLive();
            };
            credits.addEventListener("change", saveSummary);
            sgpa.addEventListener("change", saveSummary);
            host.appendChild(h("p", { class: "hint", text: "This semester is stored as a summary. It counts toward your CGPA by credit weight, but individual grades can't be checked." }));
            host.appendChild(h("div", { class: "summary-form" }, [
                h("label", {}, ["Credits counted in the SGPA", credits]),
                h("label", {}, ["SGPA (0–10)", sgpa])
            ]));
        } else {
            host.appendChild(h("p", { class: "hint", text: isCompleted
                ? "These are your actual grades. They count toward your CGPA."
                : "These are predicted grades for experimenting. They are saved separately and never change your actual CGPA until you mark the semester completed." }));

            if (sem.courses.some(gpa.isNgcr)) {
                host.appendChild(h("p", { class: "hint", text: "Courses marked NGCR are non-graded core requirements. They are kept in your history but are not counted in SGPA or CGPA." }));
            }
            if (!sem.courses.length) {
                host.appendChild(h("p", { class: "hint", text: "No courses yet. Paste a timetable above or add one by hand." }));
            } else {
                host.appendChild(h("div", { class: "course-head", "aria-hidden": "true" }, [
                    h("span", { text: "Course" }), h("span", { text: "Credits" }), h("span", { text: "Counts" }),
                    h("span", { text: isCompleted ? "Actual grade" : "Predicted" }), h("span")
                ]));
            }
            var rows = h("div", { id: "courseRows" });
            var excludedIds = {};
            gpa.computeSemester(sem).excluded.forEach(function (e) { excludedIds[e.id] = true; });
            sem.courses.forEach(function (c) {
                var row = buildCourseRow(sem, c);
                if (excludedIds[c.id]) row.classList.add("excluded");
                rows.appendChild(row);
            });
            host.appendChild(rows);
            host.appendChild(h("button", { class: "btn ghost small", type: "button", text: "+ Add course", onclick: function () {
                if (commit(model.addBlankCourse(state, sem.number))) renderAll();
            } }));
        }

        host.appendChild(buildResultBlock(sem));
        renderSemMessage();
    }

    function createSem(opts) {
        if (commit(model.createSemester(state, selected, opts))) { semMessage = null; renderAll(); }
    }

    async function markCompleted(staleSem) {
        // Grades may have been edited since this card was rendered; always show the current ones.
        var sem = model.getSemester(state, staleSem.number) || staleSem;
        var body = [h("p", { text: "The grades below become your actual grades for Semester " + sem.number +
            " and start counting toward your CGPA. You can correct any of them afterwards, and your predictions are kept." })];
        if (sem.kind === "courses" && sem.courses.length) {
            body.push(h("ul", {}, sem.courses.map(function (c) {
                var g = c.actualGrade !== null ? c.actualGrade : c.predictedGrade;
                return h("li", { text: c.name + ": " + (g === null ? "no grade" : g) + (c.credits === null ? " (credits missing)" : "") });
            })));
        }
        var ok = await confirmDialog({ title: "Mark Semester " + sem.number + " as completed?", body: body,
            okLabel: "Mark as completed", plain: "Predicted grades become actual grades and count toward CGPA." });
        if (!ok) return;
        if (commit(model.markCompleted(state, sem.number))) {
            semMessage = { text: "Semester " + sem.number + " is now completed. Check each grade and correct any that differ from your result.", kind: "ok" };
            renderAll();
        }
    }

    async function reopen(sem) {
        var ok = await confirmDialog({ title: "Reopen Semester " + sem.number + " as ongoing?",
            body: [h("p", { text: "It will stop counting toward your actual CGPA and show projected results instead. Your actual grades are kept." })],
            okLabel: "Reopen", plain: "It will stop counting toward your actual CGPA." });
        if (!ok) return;
        if (commit(model.reopenSemester(state, sem.number))) { semMessage = null; renderAll(); }
    }

    async function deleteSem(sem) {
        var ok = await confirmDialog({ title: "Delete Semester " + sem.number + "?", danger: true,
            body: [h("p", { text: "This permanently removes the semester and all of its courses and grades from this browser. Export a backup first if you might need them." })],
            okLabel: "Delete semester", plain: "This permanently removes the semester." });
        if (!ok) return;
        if (commit(model.deleteSemester(state, sem.number))) { semMessage = null; renderAll(); }
    }

    // ---- data: export / import / clear -----------------------------------------------------

    function setDataMessage(nodes, kind) {
        var host = $("dataMessages");
        clear(host);
        if (nodes) host.appendChild(h("div", { class: "msg " + (kind || ""), role: kind === "error" ? "alert" : "status" }, nodes));
    }

    $("exportBtn").addEventListener("click", function () {
        download("vtop-gpa-backup-" + today() + ".json", storage.buildExport(state));
        setDataMessage(["Backup downloaded. Keep it somewhere safe; it contains your course names, credits and grades."], "ok");
    });

    $("importFile").addEventListener("change", function (ev) {
        var input = ev.target;
        var file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        if (file.size > 1000000) { setDataMessage(["That file is too large to be a backup from this app."], "error"); return; }

        var reader = new FileReader();
        reader.onerror = function () { setDataMessage(["The file could not be read."], "error"); };
        reader.onload = async function () {
            var parsed = storage.parseImport(String(reader.result));
            if (!parsed.ok) {
                setDataMessage(["Import cancelled – nothing was changed. " + (parsed.errors.length === 1 ? parsed.errors[0] :
                    "Problems found:"), parsed.errors.length > 1 ? h("ul", {}, parsed.errors.slice(0, 8).map(function (e) { return h("li", { text: e }); })) : null], "error");
                return;
            }
            var incomingCount = parsed.state.semesters.length;
            var ok = await confirmDialog({ title: "Replace your data with this backup?",
                body: [h("p", { text: "This backup has " + plural(incomingCount, "semester", "semesters") + ". Your current data (" +
                    plural(state.semesters.length, "semester", "semesters") + ") will be replaced. A copy of the current data is kept in this browser in case you change your mind." })],
                okLabel: "Replace my data", danger: true, plain: "Your current data will be replaced." });
            if (!ok) { setDataMessage(["Import cancelled – nothing was changed."]); return; }

            var res = store.replaceWith(parsed.state);
            if (!res.ok) {
                setDataMessage([res.reason === "backup-failed"
                    ? "Import cancelled – your browser has no room to keep a safety copy of your current data. Nothing was changed."
                    : "Import failed – your browser is not allowing data to be saved. Nothing was changed."], "error");
                return;
            }
            state = parsed.state;
            selected = state.currentSemester || (state.semesters.length ? state.semesters[0].number : 1);
            semMessage = null;
            setBanner("save", null);
            setBanner("storage", null);
            renderAll();
            setDataMessage(["Backup imported (" + plural(incomingCount, "semester", "semesters") + ")."], "ok");
        };
        reader.readAsText(file);
    });

    $("clearBtn").addEventListener("click", async function () {
        var ok = await confirmDialog({ title: "Clear all data?", danger: true,
            body: [h("p", { text: "This permanently deletes every semester, course and grade saved in this browser, including any safety copies. This can't be undone. Export a backup first if you might want your data back." })],
            okLabel: "Delete everything", plain: "This permanently deletes everything saved in this browser." });
        if (!ok) return;
        var res = store.clearAll();
        state = model.emptyState();
        selected = 1;
        semMessage = null;
        draft = null;
        closeHistoryReview();
        $("subjectsCard").hidden = true;
        setBanner("storage", null);
        setBanner("save", null);
        renderAll();
        setDataMessage([res.ok ? "All saved data was deleted." : "Data was cleared on screen, but this browser would not let us delete the stored copy."], res.ok ? "ok" : "error");
    });

    // ---- startup ---------------------------------------------------------------------------

    function handleLoad(loaded) {
        state = loaded.state;
        if (loaded.status === "unavailable") {
            setBanner("storage", h("p", { text: "Your browser is blocking local storage, so your data can't be saved between visits. You can still use the calculator, and Export backup works." }), "warn");
        } else if (loaded.status === "corrupt") {
            var box = h("div", {}, [
                h("p", { text: loaded.message }),
                h("p", { text: loaded.blocked
                    ? "A safety copy could not be made, so saving is paused to protect it. Download it, then clear data to start fresh."
                    : "A copy was kept in this browser and the original was not changed. You can start again; saving will replace the original." }),
                h("div", { class: "button-row" }, [
                    h("button", { class: "btn ghost small", type: "button", text: "Download unreadable data", onclick: function () {
                        var raw = store.readRaw();
                        if (raw !== null) download("vtop-gpa-unreadable-" + today() + ".json", raw);
                    } })
                ])
            ]);
            setBanner("storage", box, "error");
        }
        selected = state.currentSemester || (state.semesters.length ? state.semesters[state.semesters.length - 1].number : 1);
    }

    window.addEventListener("storage", function (e) {
        if (e.key !== storage.KEY) return;
        setBanner("tab", h("div", {}, [
            h("p", { text: "Your data was changed in another tab. Reload to see the latest; saving from this tab would overwrite it." }),
            h("div", { class: "button-row" }, [h("button", { class: "btn ghost small", type: "button", text: "Reload", onclick: function () { window.location.reload(); } })])
        ]), "warn");
    });

    function renderAll() {
        renderTiles();
        renderNav();
        renderSemester();
        if (draft) refreshReview();
        if (histDraft) renderHistoryReview();
    }

    handleLoad(store.load());
    renderAll();
})();
