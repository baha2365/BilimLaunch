/*
 * BilimLaunch -- the field-of-study list and the fast search behind the field drop-down.
 * Keep GROUPS, POPULAR and SYNONYMS below identical to backend/auth/fields.js
 * (`node check_fields.js` in backend/ checks it).
 *
 *   BLFields.search("mech eng") -> Mechanical Engineering, ...
 *   BLFields.search("cs")       -> Computer Science (typed as "CS"), ...
 *   BLFields.canonical("AI")    -> "Artificial Intelligence"
 */
(function () {
  "use strict";

  const GROUPS = [
    { title: "Computing and IT", fields: ["Computer Science", "Software Engineering", "Data Science", "Artificial Intelligence", "Cybersecurity", "Information Technology", "Information Systems", "Data Analytics", "Computer Engineering"] },
    { title: "Engineering", fields: ["General Engineering", "Mechanical Engineering", "Electrical Engineering", "Electronic Engineering", "Civil Engineering", "Chemical Engineering", "Aerospace Engineering", "Biomedical Engineering", "Industrial Engineering", "Materials Science and Engineering", "Environmental Engineering", "Petroleum Engineering", "Mining Engineering", "Energy Engineering", "Nuclear Engineering", "Automotive Engineering", "Telecommunications Engineering", "Mechatronics", "Robotics"] },
    { title: "Natural Sciences and Mathematics", fields: ["Physics", "Astronomy and Astrophysics", "Chemistry", "Biochemistry", "Biology", "Genetics", "Microbiology", "Biotechnology", "Neuroscience", "Marine Biology", "Mathematics", "Applied Mathematics", "Statistics", "Actuarial Science", "Environmental Science", "Geology", "Geography", "Sustainability"] },
    { title: "Health and Medicine", fields: ["Medicine", "Dentistry", "Pharmacy", "Nursing", "Public Health", "Veterinary Medicine", "Biomedical Science", "Physiotherapy", "Nutrition and Dietetics", "Medical Laboratory Science", "Healthcare Management", "Health Sciences", "Sports Science"] },
    { title: "Business and Economics", fields: ["Business Administration", "Management", "International Business", "Finance", "Accounting", "Economics", "Marketing", "Entrepreneurship", "Human Resource Management", "Supply Chain and Logistics", "Business Analytics", "Real Estate", "Hospitality and Tourism"] },
    { title: "Law and Social Sciences", fields: ["Law", "International Relations", "Political Science", "Public Policy", "Public Administration", "Sociology", "Psychology", "Anthropology", "Criminology", "Social Work", "Development Studies"] },
    { title: "Humanities and Languages", fields: ["History", "Philosophy", "Literature", "English Language and Literature", "Linguistics", "Foreign Languages", "Translation and Interpreting", "Archaeology", "Religious Studies", "Classics", "Cultural Studies", "Area Studies"] },
    { title: "Education", fields: ["Education", "Early Childhood Education", "Special Education", "English Language Teaching", "Physical Education"] },
    { title: "Arts, Design and Media", fields: ["Architecture", "Urban Planning", "Interior Design", "Graphic Design", "Product Design", "Fashion Design", "Fine Arts", "Music", "Film Studies", "Performing Arts", "Animation and Game Design", "Journalism", "Media and Communications", "Public Relations"] },
    { title: "Agriculture and Food", fields: ["Agriculture", "Food Science and Technology", "Forestry"] },
    { title: "Interdisciplinary and Other", fields: ["Liberal Arts", "Interdisciplinary Studies", "Aviation"] },
  ];

  // Shown first when the box is empty, and used to break ties between equally good matches.
  const POPULAR = ["Computer Science", "Data Science", "Artificial Intelligence", "Software Engineering", "Business Administration", "Economics", "Finance", "Medicine", "Law", "Psychology", "Mechanical Engineering", "Architecture", "International Relations", "Biology"];

  /** Other ways people write a field: official name -> spellings that should find / be saved as it. */
  const SYNONYMS = {
    "Computer Science": ["cs", "cse", "comp sci", "compsci", "computer sciences", "computing", "programming", "computer science and engineering"],
    "Software Engineering": ["swe", "software development", "software engineer", "software"],
    "Data Science": ["big data", "data scientist"],
    "Artificial Intelligence": ["ai", "ml", "machine learning", "deep learning", "artificial intelligence and machine learning"],
    "Cybersecurity": ["cyber security", "information security", "infosec"],
    "Information Technology": ["it", "ict", "info tech", "information technologies"],
    "Information Systems": ["mis", "management information systems"],
    "Data Analytics": ["data analysis", "analytics"],
    "Computer Engineering": ["comp eng", "computer systems engineering"],

    "General Engineering": ["engineering", "engineering sciences"],
    "Electrical Engineering": ["ece", "electrical and electronic engineering", "electrical and computer engineering", "power systems"],
    "Electronic Engineering": ["eee", "electronics"],
    "Civil Engineering": ["structural engineering", "construction", "construction engineering"],
    "Aerospace Engineering": ["aeronautical engineering", "aeronautics"],
    "Biomedical Engineering": ["bme"],
    "Petroleum Engineering": ["oil and gas", "oil and gas engineering"],
    "Energy Engineering": ["power engineering", "renewable energy"],
    "Mechatronics": ["automation", "mechatronic engineering"],

    "Astronomy and Astrophysics": ["astro", "astrophysics"],
    "Biology": ["life sciences", "molecular biology", "cell biology", "zoology", "botany"],
    "Marine Biology": ["marine science", "oceanography"],
    "Mathematics": ["maths", "math"],
    "Statistics": ["stats"],
    "Environmental Science": ["environment", "environmental studies", "ecology", "climate science"],
    "Geology": ["earth science", "earth sciences", "geosciences"],
    "Sustainability": ["sustainable development"],

    "Medicine": ["mbbs", "general medicine", "medical", "doctor", "md"],
    "Dentistry": ["dental", "stomatology"],
    "Pharmacy": ["pharmaceutical sciences", "pharmaceutics"],
    "Nursing": ["nurse", "midwifery"],
    "Public Health": ["global health", "epidemiology"],
    "Biomedical Science": ["biomedicine", "biomedical sciences"],
    "Physiotherapy": ["physical therapy", "physio"],
    "Sports Science": ["sport science", "kinesiology", "exercise science"],

    "Business Administration": ["business", "mba", "bba", "business studies"],
    "Management": ["business management", "project management"],
    "International Business": ["international trade", "global business"],
    "Finance": ["banking", "banking and finance", "investment", "fintech"],
    "Accounting": ["accountancy", "accounting and finance", "audit"],
    "Economics": ["econ", "economy", "econometrics"],
    "Marketing": ["digital marketing"],
    "Entrepreneurship": ["startup", "startups"],
    "Human Resource Management": ["hr", "human resources", "hrm"],
    "Supply Chain and Logistics": ["logistics", "supply chain", "operations management"],
    "Real Estate": ["property"],
    "Hospitality and Tourism": ["hospitality", "tourism", "hotel management", "hospitality management", "tourism management"],

    "Law": ["llb", "legal studies", "jurisprudence", "international law"],
    "International Relations": ["ir", "international affairs", "diplomacy"],
    "Political Science": ["politics", "poli sci", "political studies", "government"],
    "Public Policy": ["policy"],
    "Public Administration": ["public management", "public admin"],
    "Psychology": ["psych", "clinical psychology", "counselling", "counseling", "cognitive science"],
    "Sociology": ["social sciences"],
    "Criminology": ["criminal justice"],
    "Development Studies": ["international development"],

    "Literature": ["lit", "literary studies"],
    "English Language and Literature": ["english", "english philology"],
    "Linguistics": ["philology", "applied linguistics"],
    "Foreign Languages": ["foreign language", "languages", "modern languages", "language studies"],
    "Translation and Interpreting": ["translation", "translator", "interpreting"],
    "Religious Studies": ["religion", "theology", "islamic studies"],
    "Area Studies": ["oriental studies", "asian studies", "european studies", "eurasian studies", "regional studies", "turkology", "sinology"],

    "Education": ["pedagogy", "teaching", "teacher training", "primary education"],
    "Early Childhood Education": ["early childhood", "preschool education"],
    "Special Education": ["special needs education"],
    "English Language Teaching": ["tesol", "tefl", "teaching english", "elt"],
    "Physical Education": ["pe", "physical culture"],

    "Architecture": ["architect"],
    "Urban Planning": ["urban design", "city planning"],
    "Graphic Design": ["graphic arts", "visual communication"],
    "Product Design": ["industrial design"],
    "Fine Arts": ["art", "arts", "painting", "sculpture"],
    "Music": ["musicology"],
    "Film Studies": ["film", "cinema", "filmmaking"],
    "Performing Arts": ["theatre", "theater", "drama", "dance", "acting"],
    "Animation and Game Design": ["animation", "game design", "game development", "gamedev"],
    "Media and Communications": ["media", "communication", "communications", "communication studies", "mass media"],
    "Public Relations": ["pr"],

    "Agriculture": ["agri", "agronomy"],
    "Food Science and Technology": ["food", "food technology"],
    "Forestry": ["forest"],

    "Liberal Arts": ["humanities", "liberal arts and sciences"],
    "Interdisciplinary Studies": ["general studies", "interdisciplinary"],
    "Aviation": ["pilot", "air traffic"],
  };

  // lower-case, no accents, "&" read as "and", every other symbol a single space
  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  var NAMES = [];
  var entries = [];
  GROUPS.forEach(function (group) {
    var groupWords = fold(group.title).split(" ");
    group.fields.forEach(function (name) {
      var key = fold(name);
      NAMES.push(name);
      entries.push({ name: name, key: key, words: key.split(" "), groupWords: groupWords });
    });
  });

  var byKey = {};
  entries.forEach(function (e) { byKey[e.key] = e.name; });
  var aliasList = [];
  Object.keys(SYNONYMS).forEach(function (name) {
    SYNONYMS[name].forEach(function (alias) {
      var key = fold(alias);
      aliasList.push({ alias: key, name: name, words: key.split(" ") });
      if (!byKey[key]) byKey[key] = name;
    });
  });

  function canonical(value) {
    var key = fold(value);
    return key ? byKey[key] || null : null;
  }

  // Edit distance that counts a swapped pair of neighbouring letters ("fiannce") as one slip.
  function distance(a, b) {
    var m = a.length, n = b.length, i, j, d = [];
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 1; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  }

  // Does the start of `text` look like `q` allowing a small typo? ("sience" ~ "scien" of Science)
  function fuzzyStart(q, text) {
    if (q.length < 3) return false;
    var allowed = q.length >= 6 ? 2 : 1;
    var best = 99;
    for (var len = q.length - 1; len <= q.length + 1; len++) {
      if (len < 2 || len > text.length) continue;
      best = Math.min(best, distance(q, text.slice(0, len)));
    }
    return best <= allowed;
  }

  // every typed word starts some word of `words` ("mech eng" ~ "mechanical engineering", in any order)
  function allPrefix(words, toks) {
    return toks.every(function (t) { return words.some(function (w) { return w.indexOf(t) === 0; }); });
  }

  // like allPrefix, but each typed word may contain a small typo
  function allFuzzy(words, toks) {
    return toks.every(function (t) { return words.some(function (w) { return w.indexOf(t) === 0 || fuzzyStart(t, w); }); });
  }

  /**
   * Fast search. Order of the answers:
   *   0. exactly what you typed: the name itself, or a synonym ("cs", "ai", "art")
   *   1. names that START with it ("comp" -> Computer Science, Computer Engineering ...)
   *   2. synonyms that start with it
   *   3. names where every typed word starts some word ("mech eng", "science computer")
   *   4. synonyms matched the same way
   *   5. everything in a category whose title matches ("health" -> all of Health and Medicine)
   *   6. names that contain it anywhere ("tech" -> Biotechnology ...)
   *   7. close misses, only when there is nothing else ("compter sience")
   * Inside each group the popular fields come first, then alphabetical order.
   */
  function search(query) {
    var q = fold(query);
    if (!q) return entries.map(function (e) { return { name: e.name, tier: 0, via: "" }; });
    var toks = q.split(" ");

    var seen = {};
    var out = [];
    function add(name, tier, via) {
      if (seen[name]) return;
      seen[name] = true;
      out.push({ name: name, tier: tier, via: via || "" });
    }

    entries.forEach(function (e) { if (e.key === q) add(e.name, 0); });
    aliasList.forEach(function (a) { if (a.alias === q) add(a.name, 0, a.alias); });
    entries.forEach(function (e) { if (e.key.indexOf(q) === 0) add(e.name, 1); });
    aliasList.forEach(function (a) { if (a.alias.indexOf(q) === 0) add(a.name, 2, a.alias); });
    entries.forEach(function (e) { if (allPrefix(e.words, toks)) add(e.name, 3); });
    aliasList.forEach(function (a) { if (allPrefix(a.words, toks)) add(a.name, 4, a.alias); });
    entries.forEach(function (e) { if (allPrefix(e.groupWords, toks)) add(e.name, 5); });
    if (q.length >= 3) entries.forEach(function (e) { if (e.key.indexOf(q) > 0) add(e.name, 6); });
    if (!out.length) {
      entries.forEach(function (e) { if (allFuzzy(e.words, toks)) add(e.name, 7); });
      aliasList.forEach(function (a) { if (allFuzzy(a.words, toks)) add(a.name, 7, a.alias); });
    }

    out.sort(function (x, y) {
      if (x.tier !== y.tier) return x.tier - y.tier;
      var px = POPULAR.indexOf(x.name), py = POPULAR.indexOf(y.name);
      if (px !== py && (px >= 0 || py >= 0)) return (px < 0 ? 999 : px) - (py < 0 ? 999 : py);
      return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
    });
    return out;
  }

  window.BLFields = { NAMES: NAMES, GROUPS: GROUPS, POPULAR: POPULAR, SYNONYMS: SYNONYMS, canonical: canonical, search: search, fold: fold };
})();