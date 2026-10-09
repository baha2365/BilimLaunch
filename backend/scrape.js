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
  const seen = new Set();
  const items = [];
  container.querySelectorAll("li, h2, h3, h4, td, a").forEach((el) => {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (text.length < 3 || text.length > 90 || seen.has(key)) return;
    seen.add(key);
    items.push(text);
  });
  return items.slice(0, 1500);
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

module.exports = { scrapeUrl, scrapeListItems, extractListItems, closeBrowser, extractPageText, UNWANTED_SELECTORS };