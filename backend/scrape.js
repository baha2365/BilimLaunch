const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1920, height: 1080 };
const NAV_TIMEOUT_MS = 60000;
const BODY_WAIT_MS = 10000;
const MAX_CHARS_PER_PAGE = 6000; // keep each page's extracted text bounded, same budget as before

// Elements that are never useful for extracting admissions facts -- removed
// from the DOM before anything else, so none of it reaches the LLM.
const UNWANTED_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "script",
  "style",
  "noscript",
  "form",
  ".menu",
  ".sidebar",
  '[role="navigation"]',
  "#sidebar",
  ".breadcrumb",
  ".skip-link",
];

/**
 * Runs INSIDE the page via page.evaluate -- must be self-contained (no
 * closures over outer variables except what's passed as arguments), since
 * Puppeteer serializes this function into the browser's own JS context.
 * This is deliberately the same logic as the working reference
 * implementation: strip boilerplate selectors, prefer a real content
 * container over <body>, then collapse whitespace to save tokens.
 */
function extractPageText(unwantedSelectors) {
  unwantedSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  });

  const mainContainer =
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector("#content") ||
    document.querySelector(".main-content") ||
    document.body;

  let text = mainContainer.innerText || mainContainer.textContent || "";
  text = text.replace(/\n\s*\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  return text;
}

/**
 * Runs INSIDE the page. Collects short list-like entries (programme / major
 * names) from a "courses A-Z" style page: li, headings, links and table
 * cells inside the main content, deduplicated. No LLM involved -- these are
 * the page's own words, so nothing can be invented.
 */
function extractListItems(unwantedSelectors) {
  unwantedSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  });
  const container =
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector("#content") ||
    document.querySelector(".main-content") ||
    document.body;

  // Page furniture that sneaks into lists: pagination, feedback widgets,
  // calls to action, admissions/funding signposts. Matched on the whole
  // entry so real subjects such as "Financial Mathematics" survive.
  const NOISE = [
    /^(page|step)\s*\d+$/i, /^(yes|no)\b/i, /^filter/i, /^search/i, /^(next|previous|back|home|menu|contact)\b/i,
    /^(apply|log ?in|sign (up|in)|read more|learn more|find (out|your|a)|explore|plan your|visit|choosing|important notice|any questions|can't find|did you know|was this page|most popular|more |view |show |see )/i,
    /^(guide|application|admissions?|fees?|funding|scholarships?|financial (support|aid)|accommodation|news|events?|cookies?|privacy|accessibility|terms|undergraduate courses|summary table|courses that|which .* colleges|selection criteria|access )/i,
    /\b(a-z|az)\b/i, /\?$/, /@/, /^\d+\s+results?/i,
  ];
  const seen = new Set();
  const items = [];
  const consider = (text) => {
    text = (text || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (text.length < 3 || text.length > 70 || text.split(" ").length > 8) return;
    if (seen.has(key) || NOISE.some((re) => re.test(text))) return;
    seen.add(key);
    items.push(text);
  };

  // List entries that are just a link (course/major index style), and
  // headings (card-style listings such as Harvard's concentrations).
  container.querySelectorAll("li").forEach((li) => {
    const link = li.querySelector("a");
    const text = (li.textContent || "").replace(/\s+/g, " ").trim();
    if (link && (link.textContent || "").replace(/\s+/g, " ").trim() === text) consider(text);
  });
  container.querySelectorAll("h3, h4").forEach((h) => consider(h.textContent));
  return items.slice(0, 1500);
}

/**
 * Runs INSIDE the page. Finds links that probably lead to a list of
 * programmes / majors / courses, scored by how list-like their text or URL
 * is. Navigation is NOT stripped here -- these links usually live in it.
 */
function findProgrammeLinks() {
  const STRONG = /(majors|concentrations|a-z|az-list|course[- ]?list|programs? of study|programmes? of study|fields? of study|degrees? and (majors|programs)|all programs|all programmes|explore (majors|programs|programmes))/i;
  const WEAK = /(majors?|programs?|programmes?|courses|departments|academics|subjects|degrees)/i;
  const BAD = /(scholar|tuition|financ|apply|admission|donat|give|news|event|career|jobs|login|alumni|visit|athletic|research|contact)/i;
  const scored = new Map();
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href;
    const text = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^https?:/.test(href) || text.length > 60 || BAD.test(text)) return;
    const haystack = text + " " + href;
    let score = 0;
    if (STRONG.test(haystack)) score = 3;
    else return; // weak matches ("Academics", "Programs") lead to directories, not subject lists
    const clean = href.split("#")[0];
    if (!scored.has(clean) || scored.get(clean) < score) scored.set(clean, score);
  });
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([url]) => url);
}

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1920,1080"],
    });
  }
  return browserPromise;
}

/**
 * Fetches one URL with a real (stealth-patched) browser and returns its
 * cleaned text, bounded to MAX_CHARS_PER_PAGE. Never throws -- a page that
 * fails to load (timeout, DNS error, hard block) returns "" so one bad
 * page doesn't take down a whole extraction run; the caller just ends up
 * with less source text for that program, same as the old requests-based
 * fetcher's failure behavior.
 */
async function scrapeUrl(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector("body", { timeout: BODY_WAIT_MS });

    const text = await page.evaluate(extractPageText, UNWANTED_SELECTORS);
    return (text || "").slice(0, MAX_CHARS_PER_PAGE);
  } catch (err) {
    console.error(`[scrape] could not fetch ${url}: ${err.message}`);
    return "";
  } finally {
    await page.close();
  }
}

/**
 * Fetches a programme-list page and returns its short entries (see
 * extractListItems). Never throws; returns [] on failure.
 */
async function scrapeListItems(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector("body", { timeout: BODY_WAIT_MS });
    return await page.evaluate(extractListItems, UNWANTED_SELECTORS);
  } catch (err) {
    console.error(`[scrape] could not fetch list ${url}: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

/** Returns up to 3 candidate programme-list URLs linked from `url`. */
async function discoverProgrammeLinks(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector("body", { timeout: BODY_WAIT_MS });
    return await page.evaluate(findProgrammeLinks);
  } catch (err) {
    console.error(`[scrape] could not discover links on ${url}: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Closes the shared browser instance. Standalone scripts (refresh-all.js,
 * fill-gaps.js) should call this before exiting; the long-running server
 * calls it on shutdown. Safe to call even if no browser was ever launched.
 */
async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { scrapeUrl, scrapeListItems, discoverProgrammeLinks, findProgrammeLinks, extractListItems, closeBrowser, extractPageText, UNWANTED_SELECTORS };