/*
 * BilimLaunch — MVP client logic.
 *
 * There is no backend yet, so accounts and profiles are kept in
 * localStorage under the keys below. This is only meant to make the
 * login → register → profile flow feel real while the product is
 * being designed; swap `Store` for real API calls once a backend exists.
 */

const STORAGE_USERS_KEY = "bilimlaunch_users";
const STORAGE_SESSION_KEY = "bilimlaunch_session";

/* -------------------------------------------------------------------- */
/* Store: local "database" of registered users                          */
/* -------------------------------------------------------------------- */

const Store = {
  getUsers() {
    try {
      const raw = localStorage.getItem(STORAGE_USERS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.error("BilimLaunch: could not read users", err);
      return {};
    }
  },

  saveUsers(users) {
    localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(users));
  },

  findUser(email) {
    const users = this.getUsers();
    return users[email.toLowerCase()] || null;
  },

  createUser({ name, email, password }) {
    const users = this.getUsers();
    const key = email.toLowerCase();
    const user = {
      name,
      email: key,
      password, // demo only — a real backend must hash this, never store as-is
      createdAt: new Date().toISOString(),
      profile: {
        country: "",
        university: "",
        fieldOfStudy: "",
        currentYear: "",
        gpa: "",
        ielts: "",
        targetDegree: "",
        targetCountries: "",
        extracurriculars: "",
      },
    };
    users[key] = user;
    this.saveUsers(users);
    return user;
  },

  updateProfile(email, profile) {
    const users = this.getUsers();
    const key = email.toLowerCase();
    if (!users[key]) return null;
    users[key].profile = { ...users[key].profile, ...profile };
    this.saveUsers(users);
    return users[key];
  },

  setSession(email) {
    localStorage.setItem(STORAGE_SESSION_KEY, email.toLowerCase());
  },

  getSession() {
    const email = localStorage.getItem(STORAGE_SESSION_KEY);
    return email ? this.findUser(email) : null;
  },

  clearSession() {
    localStorage.removeItem(STORAGE_SESSION_KEY);
  },
};

/* -------------------------------------------------------------------- */
/* Small DOM + validation helpers                                       */
/* -------------------------------------------------------------------- */

const qs = (selector, scope = document) => scope.querySelector(selector);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/* -------------------------------------------------------------------- */
/* Login page                                                           */
/* -------------------------------------------------------------------- */

function initLoginPage() {
  const form = qs("#loginForm");
  if (!form) return;

  if (Store.getSession()) {
    window.location.href = "profile.html";
    return;
  }

  const emailInput = qs("#email", form);
  const passwordInput = qs("#password", form);
  const formError = qs("#formError", form);

  form.addEventListener("submit", (event) => {
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

    const user = Store.findUser(emailInput.value.trim());

    if (!user || user.password !== passwordInput.value) {
      setFormError(formError, "Incorrect email or password.");
      return;
    }

    Store.setSession(user.email);
    window.location.href = "profile.html";
  });
}

/* -------------------------------------------------------------------- */
/* Register page                                                        */
/* -------------------------------------------------------------------- */

function initRegisterPage() {
  const form = qs("#registerForm");
  if (!form) return;

  if (Store.getSession()) {
    window.location.href = "profile.html";
    return;
  }

  const nameInput = qs("#name", form);
  const emailInput = qs("#email", form);
  const passwordInput = qs("#password", form);
  const confirmInput = qs("#confirmPassword", form);
  const formError = qs("#formError", form);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFormError(formError);
    [nameInput, emailInput, passwordInput, confirmInput].forEach(clearFieldError);

    let hasError = false;

    if (!nameInput.value.trim()) {
      setFieldError(nameInput, "Enter your full name.");
      hasError = true;
    }

    if (!EMAIL_PATTERN.test(emailInput.value.trim())) {
      setFieldError(emailInput, "Enter a valid email address.");
      hasError = true;
    } else if (Store.findUser(emailInput.value.trim())) {
      setFieldError(emailInput, "This email is already registered.");
      hasError = true;
    }

    if (passwordInput.value.length < 8) {
      setFieldError(passwordInput, "Use at least 8 characters.");
      hasError = true;
    }

    if (confirmInput.value !== passwordInput.value) {
      setFieldError(confirmInput, "Passwords don't match.");
      hasError = true;
    }

    if (hasError) return;

    const user = Store.createUser({
      name: nameInput.value.trim(),
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });

    Store.setSession(user.email);
    window.location.href = "profile.html";
  });
}

/* -------------------------------------------------------------------- */
/* Profile page                                                         */
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

function computeCompletion(profile) {
  const filled = PROFILE_FIELDS.filter((key) => (profile[key] || "").toString().trim() !== "");
  return Math.round((filled.length / PROFILE_FIELDS.length) * 100);
}

function initProfilePage() {
  const page = qs("#profilePage");
  if (!page) return;

  const user = Store.getSession();
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  const form = qs("#profileForm");
  const logoutBtn = qs("#logoutBtn");
  const greeting = qs("#greeting");
  const avatar = qs("#avatar");
  const nameEl = qs("#summaryName");
  const emailEl = qs("#summaryEmail");
  const completionFill = qs("#completionFill");
  const completionPercent = qs("#completionPercent");
  const completionHint = qs("#completionHint");
  const summaryDegree = qs("#summaryDegree");
  const summaryCountries = qs("#summaryCountries");
  const summaryIelts = qs("#summaryIelts");
  const saveStatus = qs("#saveStatus");

  function renderSummary(profile) {
    const percent = computeCompletion(profile);
    completionFill.style.width = `${percent}%`;
    completionPercent.textContent = `${percent}%`;
    completionHint.textContent =
      percent === 100
        ? "Your profile is ready for Match AI once it launches."
        : "Fill in every field so Match AI can score your applications accurately.";

    summaryDegree.textContent = profile.targetDegree || "Not set";
    summaryCountries.textContent = profile.targetCountries || "Not set";
    summaryIelts.textContent = profile.ielts || "Not set";
  }

  greeting.textContent = `Signed in as ${user.name}`;
  avatar.textContent = user.name.trim().charAt(0).toUpperCase() || "?";
  nameEl.textContent = user.name;
  emailEl.textContent = user.email;

  PROFILE_FIELDS.forEach((key) => {
    const input = qs(`#${key}`, form);
    if (input) input.value = user.profile[key] || "";
  });

  renderSummary(user.profile);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const updated = {};
    PROFILE_FIELDS.forEach((key) => {
      const input = qs(`#${key}`, form);
      if (input) updated[key] = input.value.trim();
    });

    const savedUser = Store.updateProfile(user.email, updated);
    renderSummary(savedUser.profile);

    saveStatus.classList.add("is-visible");
    window.clearTimeout(form._saveTimeout);
    form._saveTimeout = window.setTimeout(() => {
      saveStatus.classList.remove("is-visible");
    }, 2200);
  });

  logoutBtn.addEventListener("click", () => {
    Store.clearSession();
    window.location.href = "index.html";
  });
}

/* -------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  initLoginPage();
  initRegisterPage();
  initProfilePage();
});