/*
 * BilimLaunch — one admission plan (plan.html?id=...).
 *
 * Shows the personal roadmap: progress, the AI advisor's assessment, the
 * requirements check (gap analysis), the next tasks and the nine stages.
 * Clicking a task opens a panel with the full task, a "mark as completed"
 * button and the AI Task Assistant (a chat about that one task).
 *
 * All data comes from /api/plans/:id; every change returns the whole updated
 * plan, which is simply drawn again.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const planId = params.get("id") || "";
  const $ = (id) => document.getElementById(id);

  const DEADLINE_SOURCE = {
    university: "found on the university's page",
    estimated: "an estimate: confirm it on the official site",
    you: "set by you",
  };
  const PRIORITY_LABEL = { high: "High priority", normal: "", low: "Optional" };
  const GAP_LABEL = { met: "Met", missing: "Missing", unknown: "Check", optional: "Optional" };
  const CHIPS = ["Help me with this task", "Explain the steps in more detail", "What do I need to prepare first?", "Check what I wrote"];

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function daysBetween(fromIso, toIso) {
    const a = fromIso.split("-").map(Number);
    const b = toIso.split("-").map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  /** Only https links and our own letter page may be opened from a task. */
  function safeHref(url) {
    return /^https:\/\//i.test(url) || /^letter\.html\?/.test(url) ? url : null;
  }

  Auth.requireUser().then((user) => {
    if (user) main(user);
  });

  function main(user) {
    Auth.wireTopbar(user);

    const statusEl = $("planStatus");
    let view = null;
    let openTaskId = null;
    let lastFocus = null;
    const openStages = new Set();
    let stagesInitialised = false;
    let adviceRequested = false;

    function showStatus(message, kind) {
      statusEl.textContent = message;
      statusEl.classList.toggle("is-error", kind === "error");
      statusEl.classList.toggle("is-loading", kind === "loading");
      statusEl.classList.toggle("is-visible", !!message);
    }

    /* ------------------------------------------------------------ helpers */

    function allTasks() {
      return view ? view.stages.flatMap((s) => s.tasks) : [];
    }

    function dueInfo(task) {
      if (!task.dueDate || task.status === "done") return { label: task.dueDate ? fmtDate(task.dueDate) : "", cls: "" };
      const left = daysBetween(view.today, task.dueDate);
      if (left < 0) return { label: fmtDate(task.dueDate), cls: "overdue", tag: "Overdue" };
      if (left <= 7) return { label: fmtDate(task.dueDate), cls: "soon", tag: left === 0 ? "Due today" : `Due in ${left} day${left === 1 ? "" : "s"}` };
      return { label: fmtDate(task.dueDate), cls: "" };
    }

    function taskTags(task) {
      const tags = [];
      if (task.status === "done" && task.autoDone) tags.push(`<span class="tag tag--auto">Checked from your profile</span>`);
      else if (task.status === "done") tags.push(`<span class="tag tag--good">Completed</span>`);
      if (task.status !== "done") {
        if (task.locked) tags.push(`<span class="tag">Locked</span>`);
        const due = dueInfo(task);
        if (due.tag) tags.push(`<span class="tag tag--${due.cls}">${escapeHtml(due.tag)}</span>`);
        if (PRIORITY_LABEL[task.priority]) tags.push(`<span class="tag tag--${task.priority}">${PRIORITY_LABEL[task.priority]}</span>`);
      }
      return tags.join("");
    }

    /* -------------------------------------------------------------- render */

    function render() {
      document.title = `${view.university.name} roadmap — BilimLaunch`;
      $("planTitle").textContent = view.university.name;
      $("planSub").textContent = [view.degreeLabel, view.program, `${view.intake.label} intake`].filter(Boolean).join(" · ");
      renderDeadline();
      renderNotices();

      const p = view.progress;
      $("statPct").textContent = `${p.percent}%`;
      $("statLeft").textContent = String(p.remaining);
      $("statCount").textContent = `${p.done} of ${p.total} tasks done`;
      $("roadFill").style.width = `${p.percent}%`;
      $("roadTrack").setAttribute("aria-valuenow", String(p.percent));
      $("roadUni").textContent = view.university.name;
      $("roadProgram").textContent = [view.program || view.degreeLabel, `${view.intake.label} intake`].join(" · ");

      renderAdvice();
      renderGap();
      renderNext();
      renderStages();
      $("planRoot").hidden = false;
    }

    function renderDeadline() {
      const d = view.deadline;
      const note = d.source === "university" && d.text ? `${DEADLINE_SOURCE.university}: “${d.text}”` : DEADLINE_SOURCE[d.source] || "";
      $("planDeadline").innerHTML = `
        <span>Application deadline: <strong>${escapeHtml(fmtDate(d.date))}</strong></span>
        <span class="tag${d.source === "estimated" ? " tag--unknown" : ""}">${escapeHtml(note)}</span>
        <button type="button" class="link-btn" id="editDeadline">Change</button>`;
      $("editDeadline").addEventListener("click", startEditDeadline);
    }

    function startEditDeadline() {
      const max = new Date(view.intake.date + "T00:00:00");
      max.setDate(max.getDate() - 1);
      const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      $("planDeadline").innerHTML = `
        <label for="deadlineInput">Application deadline:</label>
        <input type="date" id="deadlineInput" value="${escapeHtml(view.deadline.date)}" min="${escapeHtml(view.today)}" max="${iso(max)}" />
        <button type="button" class="btn btn-primary btn-small" id="saveDeadline">Save and re-plan</button>
        <button type="button" class="link-btn" id="cancelDeadline">Cancel</button>`;
      $("cancelDeadline").addEventListener("click", renderDeadline);
      $("saveDeadline").addEventListener("click", async () => {
        const value = $("deadlineInput").value;
        if (!value) return;
        $("saveDeadline").disabled = true;
        try {
          view = await Auth.api(`/api/plans/${planId}`, { method: "PATCH", body: { submissionDeadline: value } });
          showStatus("", "");
          render();
        } catch (err) {
          showStatus(err.message, "error");
          $("saveDeadline").disabled = false;
        }
      });
    }

    function renderNotices() {
      const notices = [];
      if (view.profileChanged) {
        notices.push(`<div class="adv-notice"><span>Your profile has changed since this plan was built. Update the plan so the requirements check and the tasks match it. Your progress is kept.</span><button type="button" class="btn btn-primary btn-small" data-action="replan">Update plan</button></div>`);
      }
      if (view.tightSchedule && view.progress.done < view.progress.total) {
        notices.push(`<div class="adv-notice adv-notice--warn"><span>The application deadline is less than two months away, so task dates are squeezed together. Start with the high-priority tasks, and consider a later intake if the plan feels unrealistic.</span></div>`);
      }
      const overdue = allTasks().filter((t) => t.status !== "done" && !t.locked && t.dueDate && t.dueDate < view.today).length;
      if (overdue) {
        notices.push(`<div class="adv-notice adv-notice--warn"><span>${overdue} task${overdue === 1 ? " is" : "s are"} overdue. Update the plan to spread the remaining work from today.</span><button type="button" class="btn btn-secondary btn-small" data-action="replan">Update plan</button></div>`);
      }
      $("planNotices").innerHTML = notices.join("");
    }

    function renderAdvice() {
      const a = view.advice || {};
      const card = $("advisorCard");
      const working = card.classList.contains("is-working");
      const prio = (a.priorities || []).length ? `<ol class="advisor-prio">${a.priorities.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>` : "";
      let foot = "";
      if (a.source === "ai") foot = `Written by ${escapeHtml(a.model || "the local model")} from your profile and this plan, ${a.generatedAt ? escapeHtml(new Date(a.generatedAt).toLocaleString()) : ""}. It can be wrong: check anything important on the official site.`;
      else if (!working) foot = "A short summary from the plan. The AI advisor can write a more personal one.";
      $("advisorBody").innerHTML = `<p class="advisor-summary">${escapeHtml(a.summary || "")}</p>${prio}<p class="advisor-card__foot" id="adviceFoot">${foot}</p>`;
      $("adviceBtn").textContent = a.source === "ai" ? "Refresh" : "Ask the AI advisor";
      $("adviceBtn").disabled = working;
    }

    async function requestAdvice() {
      const card = $("advisorCard");
      if (card.classList.contains("is-working")) return;
      card.classList.add("is-working");
      $("adviceBtn").disabled = true;
      $("adviceFoot").textContent = "The advisor is reading your plan. This can take a minute…";
      try {
        const data = await Auth.api(`/api/plans/${planId}/advice`, { method: "POST" });
        view.advice = data.advice;
        card.classList.remove("is-working");
        renderAdvice();
      } catch (err) {
        card.classList.remove("is-working");
        renderAdvice();
        $("adviceFoot").textContent = `The AI advisor is not available right now (${err.message}). The summary above comes from the plan itself.`;
      }
    }

    function renderGap() {
      const g = view.gap;
      const s = g.summary;
      $("gapSummary").innerHTML = [
        `<span class="tag tag--met">${s.met} met</span>`,
        s.missing ? `<span class="tag tag--missing">${s.missing} missing</span>` : "",
        s.unknown ? `<span class="tag tag--unknown">${s.unknown} to check</span>` : "",
        s.optional ? `<span class="tag tag--optional">${s.optional} optional</span>` : "",
      ].join("");
      if (!g.rows.length) {
        $("gapTable").innerHTML = `<tbody><tr><td>We did not find specific entry requirements on the pages we read for this university. The plan uses the usual steps; check the official site for the full list.</td></tr></tbody>`;
        return;
      }
      $("gapTable").innerHTML = `
        <thead><tr><th>Requirement</th><th>University asks</th><th>You</th><th>Status</th></tr></thead>
        <tbody>${g.rows
          .map(
            (r) => `<tr>
              <td>${escapeHtml(r.label)}</td>
              <td>${escapeHtml(r.required)}</td>
              <td>${escapeHtml(r.student)}${r.note ? `<span class="gap-note">${escapeHtml(r.note)}</span>` : ""}</td>
              <td><span class="tag tag--${r.status}">${GAP_LABEL[r.status]}</span></td>
            </tr>`
          )
          .join("")}</tbody>`;
    }

    function renderNext() {
      $("nextSection").hidden = !view.nextTasks.length;
      $("nextGrid").innerHTML = view.nextTasks
        .map((t) => {
          const due = dueInfo(t);
          return `<button type="button" class="next-card" data-task="${escapeHtml(t.id)}">
            <h3>${escapeHtml(t.title)}</h3>
            <div class="next-card__meta">
              ${t.estimate ? `<span class="tag">${escapeHtml(t.estimate)}</span>` : ""}
              ${t.dueDate ? `<span class="tag${due.cls ? ` tag--${due.cls}` : ""}">Due ${escapeHtml(fmtDate(t.dueDate))}</span>` : ""}
              ${PRIORITY_LABEL[t.priority] ? `<span class="tag tag--${t.priority}">${PRIORITY_LABEL[t.priority]}</span>` : ""}
            </div>
          </button>`;
        })
        .join("");
    }

    function renderStages() {
      if (!stagesInitialised) {
        const first = view.stages.find((s) => !s.locked && s.done < s.total);
        if (first) openStages.add(first.n);
        stagesInitialised = true;
      }
      $("stages").innerHTML = view.stages
        .map((s) => {
          const complete = s.done === s.total;
          const open = openStages.has(s.n);
          const rows = s.tasks
            .map((t) => {
              const meta = [t.estimate, t.dueDate && t.status !== "done" ? `due ${fmtDate(t.dueDate)}` : ""].filter(Boolean).join(" · ");
              return `<button type="button" class="task-row${t.status === "done" ? " is-done" : ""}${t.locked ? " is-locked" : ""}" data-task="${escapeHtml(t.id)}">
                <span class="task-row__dot" aria-hidden="true"></span>
                <span class="task-row__main"><span class="task-row__title">${escapeHtml(t.title)}</span>${meta ? `<span class="task-row__meta">${escapeHtml(meta)}</span>` : ""}</span>
                <span class="task-row__tags">${taskTags(t)}</span>
              </button>`;
            })
            .join("");
          return `<section class="stage${open ? " is-open" : ""}${complete ? " is-complete" : ""}${s.locked ? " is-locked" : ""}" data-stage="${s.n}">
            <button type="button" class="stage__head" aria-expanded="${open}" data-stage-toggle="${s.n}">
              <span class="stage__num">${complete ? "&#10003;" : s.n}</span>
              <span class="stage__text"><h3>${escapeHtml(s.title)}</h3><p>${escapeHtml(s.locked ? "Locked until previous tasks are done" : s.subtitle)}</p></span>
              <span class="stage__count">${s.done} of ${s.total} completed</span>
              <svg class="stage__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="stage__body">
              ${s.locked ? `<p class="stage__lock">${escapeHtml(s.lockedReason)} You can still read the tasks.</p>` : ""}
              ${rows}
            </div>
          </section>`;
        })
        .join("");
    }

    /* ---------------------------------------------------------- task panel */

    const drawer = $("drawer");
    const overlay = $("drawerOverlay");

    function renderDrawer() {
      const task = allTasks().find((t) => t.id === openTaskId);
      if (!task) return closeDrawer();
      const stage = view.stages.find((s) => s.tasks.some((t) => t.id === task.id));
      const due = dueInfo(task);

      $("drawerTitle").textContent = task.title;
      $("drawerStage").textContent = `Stage ${stage.n}: ${stage.title}`;
      $("drawerTags").innerHTML = `<span class="tag ${task.status === "done" ? "tag--good" : ""}">${task.status === "done" ? "Done" : "To do"}</span>${PRIORITY_LABEL[task.priority] ? `<span class="tag tag--${task.priority}">${PRIORITY_LABEL[task.priority]}</span>` : ""}${task.autoDone && task.status === "done" ? `<span class="tag tag--auto">Checked from your profile</span>` : ""}`;

      const resources = (task.resources || [])
        .map((r) => ({ ...r, href: safeHref(r.url) }))
        .filter((r) => r.href)
        .map((r) => `<li><a href="${escapeHtml(r.href)}"${/^https:/i.test(r.href) ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(r.label)}</a></li>`)
        .join("");

      $("drawerBody").innerHTML = `
        ${task.why ? `<h3>Why is this important?</h3><p>${escapeHtml(task.why)}</p>` : ""}
        ${(task.steps || []).length ? `<h3>What should you do?</h3><ol>${task.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>` : ""}
        ${resources ? `<h3>Useful resources</h3><ul class="res">${resources}</ul>` : ""}
        <div class="drawer__facts">
          <div><span>Estimated time</span><b>${escapeHtml(task.estimate || "—")}</b></div>
          <div><span>Deadline</span><b class="${due.cls === "overdue" ? "is-overdue" : ""}">${escapeHtml(task.dueDate ? fmtDate(task.dueDate) : "—")}${due.tag ? ` (${escapeHtml(due.tag.toLowerCase())})` : ""}</b></div>
        </div>`;

      const done = task.status === "done";
      $("drawerDone").innerHTML = `
        <button type="button" class="btn ${done ? "btn-secondary" : "btn-done"}" id="toggleDone" ${task.locked ? "disabled" : ""}>${done ? "Mark as not done" : "Mark as completed"}</button>
        <p>${task.locked ? escapeHtml(stage.lockedReason) : done ? "" : "Tick it only when you have really finished it. The roadmap and the requirements check use it."}</p>`;
      $("toggleDone").addEventListener("click", () => setTaskStatus(task, done ? "todo" : "done"));
    }

    async function setTaskStatus(task, status) {
      const btn = $("toggleDone");
      btn.disabled = true;
      try {
        view = await Auth.api(`/api/plans/${planId}/tasks/${task.id}`, { method: "PATCH", body: { status } });
        render();
        renderDrawer();
      } catch (err) {
        showStatus(err.message, "error");
        btn.disabled = false;
      }
    }

    function openDrawer(taskId, trigger) {
      openTaskId = taskId;
      lastFocus = trigger || document.activeElement;
      renderDrawer();
      renderChatShell();
      drawer.hidden = false;
      overlay.hidden = false;
      drawer.setAttribute("aria-hidden", "false");
      document.body.classList.add("drawer-open");
      $("drawerScroll").scrollTop = 0;
      requestAnimationFrame(() => {
        drawer.classList.add("is-open");
        overlay.classList.add("is-open");
        $("drawerClose").focus();
      });
      loadChat(taskId);
    }

    function closeDrawer() {
      if (!openTaskId && drawer.hidden) return;
      openTaskId = null;
      drawer.classList.remove("is-open");
      overlay.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
      document.body.classList.remove("drawer-open");
      setTimeout(() => {
        if (!openTaskId) {
          drawer.hidden = true;
          overlay.hidden = true;
        }
      }, 400);
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }

    $("drawerClose").addEventListener("click", closeDrawer);
    overlay.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && openTaskId) closeDrawer();
      // keep Tab inside the panel while it is open
      if (e.key === "Tab" && openTaskId) {
        const f = [...drawer.querySelectorAll("button:not([disabled]), a[href], textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    });

    /* ----------------------------------------------------- task assistant */

    let chat = [];
    let sending = false;

    function renderChatShell() {
      chat = [];
      renderChat();
      $("chatChips").innerHTML = CHIPS.map((c) => `<button type="button" class="chat__chip">${escapeHtml(c)}</button>`).join("");
      $("chatInput").value = "";
    }

    function renderChat(extra) {
      const msgs = chat
        .map((m, i) =>
          m.role === "user"
            ? `<div class="chat__msg chat__msg--user">${escapeHtml(m.content)}</div>`
            : `<div class="chat__msg chat__msg--assistant">${escapeHtml(m.content)}<button type="button" class="chat__copy" data-copy="${i}">Copy</button></div>`
        )
        .join("");
      $("chat").innerHTML = msgs + (extra || "");
      $("chatClear").hidden = !chat.length || sending;
      $("chatChips").hidden = chat.length > 0;
      const box = $("drawerScroll");
      if (extra || chat.length) box.scrollTop = box.scrollHeight;
    }

    async function loadChat(taskId) {
      try {
        const data = await Auth.api(`/api/plans/${planId}/tasks/${taskId}/assistant`);
        if (openTaskId !== taskId) return;
        chat = data.chat || [];
        renderChat();
        // A conversation that already exists is more useful than the top of the panel.
        if (chat.length) $("assistantTitle").scrollIntoView({ block: "start" });
      } catch (_) {
        /* the chat just starts empty */
      }
    }

    async function sendMessage(text) {
      const message = text.trim();
      if (!message || sending || !openTaskId) return;
      const taskId = openTaskId;
      sending = true;
      $("chatSend").disabled = true;
      $("chatInput").value = "";
      chat.push({ role: "user", content: message });
      renderChat(`<div class="chat__typing">The assistant is writing…</div>`);
      try {
        const data = await Auth.api(`/api/plans/${planId}/tasks/${taskId}/assistant`, { method: "POST", body: { message } });
        if (openTaskId === taskId) chat = data.chat;
        sending = false;
        if (openTaskId === taskId) renderChat();
      } catch (err) {
        sending = false;
        if (openTaskId === taskId) {
          chat.pop();
          renderChat(`<div class="chat__error">${escapeHtml(err.message)}${err.code === "assistant_failed" ? " Make sure Ollama is running (ollama serve)." : ""}</div>`);
          $("chatInput").value = message;
        }
      } finally {
        sending = false;
        $("chatSend").disabled = false;
      }
    }

    $("chatForm").addEventListener("submit", (e) => {
      e.preventDefault();
      sendMessage($("chatInput").value);
    });
    $("chatInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage($("chatInput").value);
      }
    });
    $("chatInput").addEventListener("input", (e) => {
      e.target.style.height = "auto";
      e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
    });
    $("chatChips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chat__chip");
      if (chip) sendMessage(chip.textContent);
    });
    $("chat").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-copy]");
      if (!btn) return;
      try {
        await navigator.clipboard.writeText(chat[Number(btn.dataset.copy)].content);
        btn.textContent = "Copied";
      } catch (_) {
        btn.textContent = "Select the text and copy it";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
    $("chatClear").addEventListener("click", async () => {
      if (!openTaskId || sending) return;
      try {
        await Auth.api(`/api/plans/${planId}/tasks/${openTaskId}/assistant`, { method: "DELETE" });
        chat = [];
        renderChat();
      } catch (err) {
        showStatus(err.message, "error");
      }
    });

    /* --------------------------------------------------------- page events */

    document.addEventListener("click", (e) => {
      const toggle = e.target.closest("[data-stage-toggle]");
      if (toggle) {
        const n = Number(toggle.dataset.stageToggle);
        if (openStages.has(n)) openStages.delete(n);
        else openStages.add(n);
        const section = toggle.closest(".stage");
        section.classList.toggle("is-open", openStages.has(n));
        toggle.setAttribute("aria-expanded", String(openStages.has(n)));
        return;
      }
      const taskBtn = e.target.closest("[data-task]");
      if (taskBtn && !drawer.contains(taskBtn)) return openDrawer(taskBtn.dataset.task, taskBtn);
      const action = e.target.closest("[data-action]");
      if (action && action.dataset.action === "replan") replan(action);
    });

    async function replan(button) {
      button.disabled = true;
      showStatus("Updating your plan from your current profile and the university's latest data…", "loading");
      try {
        view = await Auth.api(`/api/plans/${planId}/replan`, { method: "POST" });
        showStatus("", "");
        adviceRequested = false;
        render();
        if (openTaskId) renderDrawer();
        maybeRequestAdvice();
      } catch (err) {
        showStatus(err.message, "error");
        button.disabled = false;
      }
    }

    $("adviceBtn").addEventListener("click", requestAdvice);

    $("deleteBtn").addEventListener("click", async () => {
      if (!window.confirm("Delete this plan and all its progress? This cannot be undone.")) return;
      try {
        await Auth.api(`/api/plans/${planId}`, { method: "DELETE" });
        window.location.href = "advisor.html";
      } catch (err) {
        showStatus(err.message, "error");
      }
    });

    function maybeRequestAdvice() {
      // The first time a plan is opened there is only the rule-based summary: ask the model for a personal one.
      if (adviceRequested || !view || view.advice.source === "ai") return;
      adviceRequested = true;
      requestAdvice();
    }

    /* ---------------------------------------------------------------- load */

    if (!planId) {
      showStatus("No plan selected. Go back and choose one.", "error");
      return;
    }
    showStatus("Loading your roadmap…", "loading");
    Auth.api(`/api/plans/${encodeURIComponent(planId)}`)
      .then((data) => {
        view = data;
        showStatus("", "");
        render();
        maybeRequestAdvice();
      })
      .catch((err) => showStatus(err.status === 404 ? "This plan was not found. It may have been deleted." : err.message, "error"));
  }
})();
