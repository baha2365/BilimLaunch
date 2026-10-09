/*
 * BilimLaunch — motivation letter page.
 *
 * Flow: opened from a match card (?school=<slug>&degree=<key>) → asks the
 * questions the profile doesn't cover → POST /api/letter → shows an
 * editable letter. Answers and the last letter are kept in this browser
 * (per user and university) so nothing is lost on refresh.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("school") || "";
  const degree = params.get("degree") || "";

  const $ = (id) => document.getElementById(id);
  const user = Store.getSession();
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  $("greeting").textContent = `Signed in as ${user.name}`;
  $("logoutBtn").addEventListener("click", () => {
    Store.clearSession();
    window.location.href = "index.html";
  });

  const storageKey = (kind) => `bilimlaunch:${kind}:${user.email}:${slug}:${degree}`;
  const load = (kind) => {
    try {
      return JSON.parse(localStorage.getItem(storageKey(kind)) || "null");
    } catch (_) {
      return null;
    }
  };
  const save = (kind, value) => {
    try {
      localStorage.setItem(storageKey(kind), JSON.stringify(value));
    } catch (_) {
      /* storage unavailable: the page still works, just without drafts */
    }
  };

  const form = $("questionsForm");
  const statusEl = $("letterStatus");
  const generateBtn = $("generateBtn");

  function showStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("is-error", !!isError);
    statusEl.classList.toggle("is-visible", !!message);
  }

  function selectedGoal() {
    const checked = form.querySelector('input[name="goal"]:checked');
    return checked ? checked.value : "";
  }

  function readAnswers() {
    return {
      goal: selectedGoal(),
      goalOther: $("goalOther").value.trim(),
      whyUniversity: $("whyUniversity").value.trim(),
      whyField: $("whyField").value.trim(),
      contribution: $("contribution").value.trim(),
      highlight: $("highlight").value.trim(),
    };
  }

  function fillAnswers(a) {
    if (!a) return;
    const radio = form.querySelector(`input[name="goal"][value="${CSS.escape(a.goal || "")}"]`);
    if (radio) radio.checked = true;
    $("goalOther").value = a.goalOther || "";
    $("whyUniversity").value = a.whyUniversity || "";
    $("whyField").value = a.whyField || "";
    $("contribution").value = a.contribution || "";
    $("highlight").value = a.highlight || "";
    syncGoalOther();
  }

  function syncGoalOther() {
    $("goalOther").hidden = selectedGoal() !== "Other goal";
  }

  function showLetter(data) {
    $("letterText").value = data.letter;
    $("letterWarnings").innerHTML = (data.warnings || [])
      .map((w) => `<li>${w.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</li>`)
      .join("");
    $("letterNote").textContent =
      "Written from your profile, your answers and data from the university's official pages. You can edit the text above. Read it carefully before sending — it is a draft, and only you can confirm every statement is true.";
    $("letterResult").hidden = false;
    form.hidden = true;
    $("letterResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function missingProfile() {
    const p = user.profile || {};
    const labels = { fieldOfStudy: "field of study", country: "country of residence", university: "current university", gpa: "GPA" };
    return Object.keys(labels).filter((k) => !String(p[k] || "").trim()).map((k) => labels[k]);
  }

  async function generate() {
    const answers = readAnswers();
    if (!answers.goal) return showStatus("Please choose your goal after graduation.", true);
    if (answers.goal === "Other goal" && !answers.goalOther) return showStatus("Please describe your goal.", true);
    if (answers.whyUniversity.length < 15) return showStatus("Please tell us why you chose this university (a sentence or two).", true);
    if (answers.contribution.length < 15) return showStatus("Please tell us what you could contribute to the community.", true);

    save("answers", answers);
    generateBtn.disabled = true;
    generateBtn.textContent = "Writing your letter…";
    showStatus("Writing your letter with the local model — this can take a minute or two.", false);

    try {
      const res = await fetch("/api/letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, degree, profile: user.profile || {}, answers, applicantName: user.name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Something went wrong.");
      save("letter", body);
      showStatus("", false);
      showLetter(body);
    } catch (err) {
      showStatus(err.message, true);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate my letter";
    }
  }

  function init() {
    if (!slug) {
      showStatus("No university selected. Go back to your matches and pick one.", true);
      form.hidden = true;
      return;
    }

    fetch(`/api/universities/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((cfg) => {
        $("letterTitle").textContent = `Motivation letter — ${cfg.name}`;
        $("letterSubtitle").textContent = [cfg.city, cfg.country].filter(Boolean).join(", ");
      })
      .catch(() => {
        $("letterTitle").textContent = "Motivation letter";
      });

    const missing = missingProfile();
    if (missing.length) {
      showStatus(`Your profile is missing: ${missing.join(", ")}. The letter will be more specific if you add them on the profile page.`, false);
    }

    form.querySelectorAll('input[name="goal"]').forEach((r) => r.addEventListener("change", syncGoalOther));
    fillAnswers(load("answers"));

    form.addEventListener("input", () => {
      save("answers", readAnswers());
      $("draftStatus").textContent = "Answers saved on this device";
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      generate();
    });

    $("copyBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("letterText").value);
        $("copyBtn").textContent = "Copied";
      } catch (_) {
        $("letterText").select();
      }
      setTimeout(() => ($("copyBtn").textContent = "Copy"), 1500);
    });
    $("downloadBtn").addEventListener("click", () => {
      const blob = new Blob([$("letterText").value], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `motivation-letter-${slug}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("regenBtn").addEventListener("click", () => {
      $("letterResult").hidden = true;
      form.hidden = false;
      generate();
    });
    $("editAnswersBtn").addEventListener("click", () => {
      $("letterResult").hidden = true;
      form.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });

    const previous = load("letter");
    if (previous && previous.letter) showLetter(previous);
  }

  document.addEventListener("DOMContentLoaded", init);
})();