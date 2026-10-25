/*
 * BilimLaunch -- browser side of sign-in.
 *
 *   access token   short-lived JWT. Kept in sessionStorage (this tab only) and
 *                  sent as `Authorization: Bearer ...` on every API call.
 *   refresh token  long-lived JWT in an HttpOnly cookie. JavaScript can't read
 *                  it; the browser sends it to /api/auth/refresh, which swaps it
 *                  for a new access token (and a new refresh cookie).
 *
 * Pages call `Auth.requireUser()` first. API calls go through `Auth.api()`,
 * which refreshes an expired access token by itself and retries once.
 */
const Auth = (() => {
  const TOKEN_KEY = "bl_access";
  const HINT_KEY = "bl_signed_in"; // "I have a refresh cookie" -- lets login pages skip a pointless refresh call

  let memoryToken = null; // fallback when sessionStorage is blocked
  let cachedUser = null;
  let refreshing = null;

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || "Something went wrong.");
      this.status = status;
      this.code = body && body.code;
      this.errors = (body && body.errors) || null;
      this.body = body || {};
    }
  }

  function getToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || memoryToken;
    } catch (_) {
      return memoryToken;
    }
  }

  function setToken(token) {
    memoryToken = token;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) {
      /* private mode: memory only */
    }
  }

  function setHint(on) {
    try {
      if (on) localStorage.setItem(HINT_KEY, "1");
      else localStorage.removeItem(HINT_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  function hasHint() {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  /** True if the token exists and has more than 30 s left. */
  function isFresh(token) {
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.exp * 1000 - Date.now() > 30000;
    } catch (_) {
      return false;
    }
  }

  /** Stores the result of a successful login / verify / refresh response. */
  function setSession(data) {
    setToken(data.accessToken);
    if (data.user) cachedUser = data.user;
    setHint(true);
  }

  function clearSession() {
    setToken(null);
    cachedUser = null;
    setHint(false);
  }

  /** Asks the server for a new access token using the refresh cookie. Returns the response, or null if signed out. */
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" });
        if (!res.ok) {
          clearSession();
          return null;
        }
        const data = await res.json();
        setSession(data);
        return data;
      } catch (_) {
        return null; // offline / server down: keep whatever we have
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function goToLogin() {
    window.location.replace("index.html");
  }

  /**
   * Calls the JSON API. Adds the access token, refreshes it when it has
   * expired, and throws ApiError for any non-2xx answer. `auth:false` is for
   * the public sign-in endpoints.
   */
  async function api(path, { method = "GET", body, auth = true } = {}) {
    const send = () => {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const token = getToken();
      if (auth && token) headers.Authorization = `Bearer ${token}`;
      return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
    };

    if (auth && !isFresh(getToken())) await refresh();
    let res = await send();
    if (res.status === 401 && auth) {
      const renewed = await refresh();
      if (renewed) res = await send();
      if (res.status === 401) {
        goToLogin();
        throw new ApiError(401, { error: "Please sign in.", code: "unauthenticated" });
      }
    }

    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      /* empty body */
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  /** Where a signed-in user belongs. */
  function homeFor(user) {
    return user && user.profileCompleted ? "profile.html" : "onboarding.html";
  }

  /**
   * Call at the top of every signed-in page. Returns the user, or null after
   * redirecting (to the login page, or to onboarding if the profile is unfinished).
   */
  async function requireUser({ allowIncomplete = false } = {}) {
    let user = null;
    if (isFresh(getToken())) {
      user = cachedUser;
      if (!user) {
        try {
          user = (await api("/api/me")).user;
        } catch (_) {
          user = null;
        }
      }
    } else {
      const data = await refresh();
      user = data && data.user;
    }
    if (!user) {
      goToLogin();
      return null;
    }
    cachedUser = user;
    if (!user.profileCompleted && !allowIncomplete) {
      window.location.replace("onboarding.html");
      return null;
    }
    return user;
  }

  /** For the login / register pages: if the visitor is already signed in, send them on. */
  async function redirectIfSignedIn() {
    if (!hasHint()) return false;
    const data = await refresh();
    if (!data) return false;
    window.location.replace(homeFor(data.user));
    return true;
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch (_) {
      /* the cookie will expire on its own; still sign out locally */
    }
    clearSession();
    window.location.href = "index.html";
  }

  function wireTopbar(user) {
    const greeting = document.getElementById("greeting");
    if (greeting) greeting.textContent = `Signed in as ${user.fullName}`;
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);
  }

  return { api, ApiError, setSession, clearSession, refresh, requireUser, redirectIfSignedIn, logout, homeFor, wireTopbar, getCachedUser: () => cachedUser, setCachedUser: (u) => (cachedUser = u) };
})();
