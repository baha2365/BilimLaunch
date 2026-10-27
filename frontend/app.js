/*
 * BilimLaunch -- sign-in, sign-up, e-mail verification, onboarding and the
 * profile page. Accounts live in PostgreSQL behind /api/auth and /api/me;
 * js/auth.js handles tokens, this file handles the forms.
 */

/* -------------------------------------------------------------------- */
/* Small DOM + validation helpers                                       */
/* -------------------------------------------------------------------- */

const qs = (selector, scope = document) => scope.querySelector(selector);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/;

function setFieldError(input, message) {
  input.classList.add("has-error");
  const errorEl = document.getElementById(`${input.id}-error`);
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.add("is-visible");
  }
}

function clearFieldError(input) {
  input.classList.remove("has-error");
  const errorEl = document.getElementById(`${input.id}-error`);
  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.remove("is-visible");
  }
}

function setFormError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
}

function clearFormError(el) {
  if (!el) return;
  el.textContent = "";
  el.classList.remove("is-visible");
}

function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
}

/**
 * Shows an ApiError on a form: field messages next to their inputs and, when
 * nothing matched a field, the general message at the top.
 * `inputs` maps the server's field names to input elements.
 */
function showApiError(err, inputs, formError) {
  let matched = false;
  if (err.errors) {
    for (const [name, message] of Object.entries(err.errors)) {
      if (inputs[name]) {
        setFieldError(inputs[name], message);
        matched = true;
      }
    }
  }
  if (!matched) setFormError(formError, err.message || "Something went wrong. Please try again.");
}

const URL_ERRORS = {
  google_not_configured: "Google sign-in isn't set up on this server yet.",
  google_denied: "Google sign-in was cancelled.",
  google_state: "That Google sign-in link expired. Please try again.",
  google_failed: "We couldn't sign you in with Google. Please try again.",
  google_unverified_email: "Google says this email address isn't verified, so we can't use it.",
};

/* -------------------------------------------------------------------- */
/* Login page                                                           */
/* -------------------------------------------------------------------- */

async function initLoginPage() {
  const form = qs("#loginForm");
  if (!form) return;

  const emailInput = qs("#email", form);
  const passwordInput = qs("#password", form);
  const formError = qs("#formError");
  const submitBtn = qs('button[type="submit"]', form);

  const urlError = new URLSearchParams(window.location.search).get("error");
  if (urlError) setFormError(formError, URL_ERRORS[urlError] || "Something went wrong. Please try again.");

  if (await Auth.redirectIfSignedIn()) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError(formError);
    clearFieldError(emailInput);
    clearFieldError(passwordInput);

    let hasError = false;
    if (!EMAIL_PATTERN.test(emailInput.value.trim())) {
      setFieldError(emailInput, "Enter a valid email address.");
      hasError = true;
    }
    if (!passwordInput.value) {
      setFieldError(passwordInput, "Enter your password.");
      hasError = true;
    }
    if (hasError) return;

    setBusy(submitBtn, true, "Signing in…");
    try {
      const data = await Auth.api("/api/auth/login", {
        method: "POST",
        auth: false,
        body: { email: emailInput.value.trim(), password: passwordInput.value },
      });
      Auth.setSession(data);
      window.location.href = Auth.homeFor(data.user);
    } catch (err) {
      setBusy(submitBtn, false);
      if (err.code === "email_not_verified") {
        window.location.href = `verify.html?email=${encodeURIComponent(err.body.email || emailInput.value.trim())}`;
        return;
      }
      setFormError(formError, err.message);
    }
  });
}

/* -------------------------------------------------------------------- */
/* Register page (step 1 of 3)                                          */
/* -------------------------------------------------------------------- */

async function initRegisterPage() {
  const form = qs("#registerForm");
  if (!form) return;

  if (await Auth.redirectIfSignedIn()) return;

  const nameInput = qs("#fullName", form);
  const usernameInput = qs("#username", form);
  const emailInput = qs("#email", form);
  const passwordInput = qs("#password", form);
  const confirmInput = qs("#confirmPassword", form);
  const formError = qs("#formError");
  const submitBtn = qs('button[type="submit"]', form);
  const all = [nameInput, usernameInput, emailInput, passwordInput, confirmInput];

  // Suggest a username from the email until the person types their own.
  let usernameTouched = false;
  usernameInput.addEventListener("input", () => (usernameTouched = true));
  emailInput.addEventListener("input", () => {
    if (usernameTouched) return;
    const local = emailInput.value.split("@")[0].toLowerCase().replace(/[^a-z0-9_.]/g, "");
    usernameInput.value = local.slice(0, 30);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError(formError);
    all.forEach(clearFieldError);

    let hasError = false;
    if (nameInput.value.trim().length < 2) {
      setFieldError(nameInput, "Enter your full name.");
      hasError = true;
    }
    if (!USERNAME_PATTERN.test(usernameInput.value.trim().toLowerCase())) {
      setFieldError(usernameInput, "Use 3-30 characters: lowercase letters, numbers, dots and underscores.");
      hasError = true;
    }
    if (!EMAIL_PATTERN.test(emailInput.value.trim())) {
      setFieldError(emailInput, "Enter a valid email address.");
      hasError = true;
    }
    if (passwordInput.value.length < 8) {
      setFieldError(passwordInput, "Use at least 8 characters.");
      hasError = true;
    } else if (!/[A-Za-zÀ-￿]/.test(passwordInput.value) || !/\d/.test(passwordInput.value)) {
      setFieldError(passwordInput, "Use at least one letter and one number.");
      hasError = true;
    }
    if (confirmInput.value !== passwordInput.value) {
      setFieldError(confirmInput, "Passwords don't match.");
      hasError = true;
    }
    if (hasError) return;

    setBusy(submitBtn, true, "Creating account…");
    try {
      const data = await Auth.api("/api/auth/register", {
        method: "POST",
        auth: false,
        body: {
          fullName: nameInput.value.trim(),
          username: usernameInput.value.trim().toLowerCase(),
          email: emailInput.value.trim(),
          password: passwordInput.value,
        },
      });
      window.location.href = `verify.html?email=${encodeURIComponent(data.email)}`;
    } catch (err) {
      setBusy(submitBtn, false);
      showApiError(err, { fullName: nameInput, username: usernameInput, email: emailInput, password: passwordInput }, formError);
    }
  });
}

/* -------------------------------------------------------------------- */
/* Verify page (step 2 of 3): the 6-digit code from the e-mail          */
/* -------------------------------------------------------------------- */

function initVerifyPage() {
  const form = qs("#verifyForm");
  if (!form) return;

  const email = new URLSearchParams(window.location.search).get("email") || "";
  if (!EMAIL_PATTERN.test(email)) {
    window.location.replace("register.html");
    return;
  }

  const codeInput = qs("#code", form);
  const formError = qs("#formError");
  const notice = qs("#formNotice");
  const resendBtn = qs("#resendBtn");
  const submitBtn = qs('button[type="submit"]', form);
  qs("#verifyEmail").textContent = email;

  let cooldownTimer = null;
  function startCooldown(seconds) {
    window.clearInterval(cooldownTimer);
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        window.clearInterval(cooldownTimer);
        resendBtn.disabled = false;
        resendBtn.textContent = "Send a new code";
        return;
      }
      resendBtn.disabled = true;
      resendBtn.textContent = `Send a new code (${left}s)`;
      left -= 1;
    };
    tick();
    cooldownTimer = window.setInterval(tick, 1000);
  }
  startCooldown(60);

  let submitting = false;
  async function submit() {
    if (submitting) return;
    clearFormError(formError);
    clearFieldError(codeInput);
    const code = codeInput.value.replace(/\D/g, "");
    if (code.length !== 6) {
      setFieldError(codeInput, "Enter the 6-digit code from your email.");
      return;
    }
    submitting = true;
    setBusy(submitBtn, true, "Checking…");
    try {
      const data = await Auth.api("/api/auth/verify-email", { method: "POST", auth: false, body: { email, code } });
      Auth.setSession(data);
      // a short "verified" moment before moving on
      const card = qs("#verifyCard");
      if (card) card.classList.add("is-success");
      await new Promise((resolve) => window.setTimeout(resolve, card ? 900 : 0));
      window.location.href = Auth.homeFor(data.user);
    } catch (err) {
      setBusy(submitBtn, false);
      submitting = false;
      if (err.code === "already_verified") {
        window.location.href = "index.html";
        return;
      }
      setFormError(formError, err.message);
      codeInput.select();
    }
  }

  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
    if (codeInput.value.length === 6) submit();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  resendBtn.addEventListener("click", async () => {
    clearFormError(formError);
    notice.classList.remove("is-visible");
    resendBtn.disabled = true;
    try {
      const data = await Auth.api("/api/auth/resend-code", { method: "POST", auth: false, body: { email } });
      notice.textContent = "A new code is on its way. Check your inbox (and spam folder).";
      notice.classList.add("is-visible");
      startCooldown(data.resendAfterSeconds || 60);
    } catch (err) {
      setFormError(formError, err.message);
      startCooldown((err.body && err.body.retryAfter) || 60);
    }
  });

  codeInput.focus();
}

/* -------------------------------------------------------------------- */
/* Profile form helpers (shared by onboarding + profile page)           */
/* -------------------------------------------------------------------- */

const PROFILE_FIELDS = [
  "country",
  "university",
  "fieldOfStudy",
  "currentYear",
  "gpa",
  "ielts",
  "targetDegree",
  "targetCountries",
  "extracurriculars",
];

function readProfileForm(form) {
  const profile = {};
  PROFILE_FIELDS.forEach((key) => {
    const input = qs(`#${key}`, form);
    if (input) profile[key] = input.value.trim();
  });
  return profile;
}

function fillProfileForm(form, profile) {
  PROFILE_FIELDS.forEach((key) => {
    const input = qs(`#${key}`, form);
    if (input) input.value = (profile && profile[key]) || "";
  });
}

function profileInputs(form) {
  const inputs = {};
  PROFILE_FIELDS.concat("username").forEach((key) => {
    const input = qs(`#${key}`, form);
    if (input) inputs[key] = input;
  });
  return inputs;
}

function clearProfileErrors(form) {
  Object.values(profileInputs(form)).forEach(clearFieldError);
}

function computeCompletion(profile) {
  const filled = PROFILE_FIELDS.filter((key) => ((profile || {})[key] || "").toString().trim() !== "");
  return Math.round((filled.length / PROFILE_FIELDS.length) * 100);
}

/* -------------------------------------------------------------------- */
/* Onboarding page (step 3 of 3): the details Match AI needs            */
/* -------------------------------------------------------------------- */

async function initOnboardingPage() {
  const form = qs("#onboardingForm");
  if (!form) return;

  const user = await Auth.requireUser({ allowIncomplete: true });
  if (!user) return;
  if (user.profileCompleted) {
    window.location.replace("profile.html");
    return;
  }

  const formError = qs("#formError");
  const submitBtn = qs('button[type="submit"]', form);
  const inputs = profileInputs(form);

  qs("#welcomeName").textContent = (user.fullName || "").trim().split(/\s+/)[0] || "there";
  inputs.username.value = user.username || "";
  fillProfileForm(form, user.profile);
  const signOut = qs("#logoutBtn");
  if (signOut) signOut.addEventListener("click", Auth.logout);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError(formError);
    clearProfileErrors(form);
    setBusy(submitBtn, true, "Saving…");
    try {
      const data = await Auth.api("/api/me/profile", {
        method: "PUT",
        body: { username: inputs.username.value.trim().toLowerCase(), profile: readProfileForm(form) },
      });
      Auth.setCachedUser(data.user);
      window.location.href = "profile.html";
    } catch (err) {
      setBusy(submitBtn, false);
      showApiError(err, inputs, formError);
      const firstBad = form.querySelector(".has-error");
      if (firstBad) firstBad.focus();
    }
  });
}

/* -------------------------------------------------------------------- */
/* Google redirect landing page                                         */
/* -------------------------------------------------------------------- */

async function initAuthCallbackPage() {
  if (!qs("#authCallback")) return;
  // The server already set the refresh cookie before sending the browser here;
  // swap it for an access token and continue.
  const data = await Auth.refresh();
  if (!data) {
    window.location.replace("index.html?error=google_failed");
    return;
  }
  window.location.replace(Auth.homeFor(data.user));
}

/* -------------------------------------------------------------------- */
/* Profile page                                                         */
/* -------------------------------------------------------------------- */

async function initProfilePage() {
  const page = qs("#profilePage");
  if (!page) return;

  let user = await Auth.requireUser();
  if (!user) return;

  const form = qs("#profileForm");
  const avatar = qs("#avatar");
  const nameEl = qs("#summaryName");
  const usernameEl = qs("#summaryUsername");
  const emailEl = qs("#summaryEmail");
  const completionFill = qs("#completionFill");
  const completionPercent = qs("#completionPercent");
  const completionHint = qs("#completionHint");
  const summaryDegree = qs("#summaryDegree");
  const summaryCountries = qs("#summaryCountries");
  const summaryIelts = qs("#summaryIelts");
  const saveStatus = qs("#saveStatus");
  const profileError = qs("#profileError");

  function renderSummary(profile) {
    const percent = computeCompletion(profile);
    completionFill.style.width = `${percent}%`;
    completionPercent.textContent = `${percent}%`;
    const summaryCard = qs(".summary-card");
    if (summaryCard) summaryCard.classList.toggle("is-complete", percent === 100);
    completionHint.textContent =
      percent === 100
        ? "Your profile is complete. You're ready to find your match."
        : "Fill in every field so Match AI can score your applications accurately.";

    summaryDegree.textContent = profile.targetDegree || "Not set";
    summaryCountries.textContent = profile.targetCountries || "Not set";
    summaryIelts.textContent = profile.ielts || "Not set";
  }

  Auth.wireTopbar(user);
  // "Admin panel" button: only created for administrators, so it isn't in the
  // page for anybody else. This is just a convenience -- the server decides who
  // may actually use the admin panel (it checks the role in the database).
  if (user.role === "admin") {
    const adminLink = document.createElement("a");
    adminLink.id = "adminLink";
    adminLink.className = "btn btn-secondary btn-small";
    adminLink.href = "admin.html";
    adminLink.textContent = "Admin panel";
    const right = qs(".dash-topbar__right");
    right.insertBefore(adminLink, qs("#logoutBtn"));
  }
  avatar.textContent = user.fullName.trim().charAt(0).toUpperCase() || "?";
  nameEl.textContent = user.fullName;
  usernameEl.textContent = `@${user.username}`;
  emailEl.textContent = user.email;
  fillProfileForm(form, user.profile);
  renderSummary(user.profile);

  // Saves the form. Resolves true on success, false if the server rejected it
  // (the problems are shown next to the fields). "Find my match" waits for this.
  async function save() {
    clearFormError(profileError);
    clearProfileErrors(form);
    try {
      const data = await Auth.api("/api/me/profile", { method: "PUT", body: { profile: readProfileForm(form) } });
      user = data.user;
      Auth.setCachedUser(user);
      renderSummary(user.profile);

      saveStatus.classList.add("is-visible");
      window.clearTimeout(form._saveTimeout);
      form._saveTimeout = window.setTimeout(() => saveStatus.classList.remove("is-visible"), 2200);
      return true;
    } catch (err) {
      showApiError(err, profileInputs(form), profileError);
      return false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });

  window.ProfilePage = { save };
}

/* -------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  initLoginPage();
  initRegisterPage();
  initVerifyPage();
  initOnboardingPage();
  initAuthCallbackPage();
  initProfilePage();
});
