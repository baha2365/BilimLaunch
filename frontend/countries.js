/*
 * BilimLaunch -- the country list and the fast search behind the country drop-downs.
 * Keep the two lists below identical to server/auth/countries.js (a test checks it).
 *
 *   BLCountries.search("una")  -> United Arab Emirates, United Kingdom, United States, Uganda
 *   BLCountries.search("king") -> United Kingdom
 *   BLCountries.canonical("USA") -> "United States"
 */
(function () {
  "use strict";

  const NAMES = ["Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada", "Cape Verde", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "DR Congo", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Macau", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Republic of the Congo", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"];
  const ALIASES = {
    "usa": "United States", "us": "United States", "u.s.": "United States", "u.s.a.": "United States", "america": "United States", "united states of america": "United States", "uk": "United Kingdom", "u.k.": "United Kingdom", "britain": "United Kingdom", "great britain": "United Kingdom", "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom", "northern ireland": "United Kingdom", "uae": "United Arab Emirates", "emirates": "United Arab Emirates", "holland": "Netherlands", "the netherlands": "Netherlands", "turkiye": "Turkey", "czech republic": "Czechia", "burma": "Myanmar", "cote d'ivoire": "Ivory Coast", "cote divoire": "Ivory Coast", "democratic republic of the congo": "DR Congo", "democratic republic of congo": "DR Congo", "drc": "DR Congo", "congo-kinshasa": "DR Congo", "congo-brazzaville": "Republic of the Congo", "congo": "Republic of the Congo", "russian federation": "Russia", "swaziland": "Eswatini", "east timor": "Timor-Leste", "cabo verde": "Cape Verde", "macedonia": "North Macedonia", "vatican": "Vatican City", "holy see": "Vatican City", "republic of korea": "South Korea", "korea": "South Korea", "viet nam": "Vietnam", "lao": "Laos", "syrian arab republic": "Syria", "brunei darussalam": "Brunei", "the gambia": "Gambia", "the bahamas": "Bahamas", "palestinian territories": "Palestine", "state of palestine": "Palestine", "st lucia": "Saint Lucia", "st. lucia": "Saint Lucia", "st kitts and nevis": "Saint Kitts and Nevis", "st. kitts and nevis": "Saint Kitts and Nevis", "st vincent and the grenadines": "Saint Vincent and the Grenadines", "prc": "China", "peoples republic of china": "China", "hong kong sar": "Hong Kong", "macao": "Macau", "kyrgyz republic": "Kyrgyzstan", "bosnia": "Bosnia and Herzegovina", "trinidad": "Trinidad and Tobago", "png": "Papua New Guinea"
  };

  // Shown first when the box is empty, and used to break ties between equally close guesses.
  var POPULAR = ["United States", "United Kingdom", "Canada", "Australia", "Germany", "France", "Netherlands",
    "Italy", "Spain", "Ireland", "Sweden", "Switzerland", "Turkey", "South Korea", "Japan", "China",
    "Singapore", "Malaysia", "United Arab Emirates", "Kazakhstan"];

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[’`]/g, "'")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  var folded = NAMES.map(function (name) { return { name: name, key: fold(name) }; });
  var aliasList = Object.keys(ALIASES).map(function (alias) { return { alias: fold(alias), name: ALIASES[alias] }; });
  var byKey = {};
  folded.forEach(function (c) { byKey[c.key] = c.name; });
  aliasList.forEach(function (a) { if (!byKey[a.alias]) byKey[a.alias] = a.name; });

  function canonical(value) {
    var key = fold(value);
    return key ? byKey[key] || null : null;
  }

  // Edit distance that counts a swapped pair of neighbouring letters ("ittaly", "gemrany") as one slip.
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

  // Does the start of `text` look like `q` allowing a small typo? ("una" ~ "uni" of United)
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

  /**
   * Fast search. Order of the answers:
   *   1. names that START with what you typed ("un" -> United ...)
   *   2. other spellings that start with it ("usa", "uk", "holland")
   *   3. names where a later word starts with it ("king" -> United Kingdom)
   *   4. close misses, only when there is little else ("una" -> United ..., Uganda)
   *   5. names that contain it anywhere ("land" -> Finland, Iceland, ...)
   * Inside each group the order is alphabetical.
   */
  function search(query) {
    var q = fold(query).replace(/[.]/g, "");
    if (!q) return folded.map(function (c) { return { name: c.name, tier: 0 }; });

    var seen = {};
    var out = [];
    function add(name, tier, via) {
      if (seen[name]) return;
      seen[name] = true;
      out.push({ name: name, tier: tier, via: via || "" });
    }

    folded.forEach(function (c) { if (c.key.replace(/[.]/g, "").indexOf(q) === 0) add(c.name, 0); });
    aliasList.forEach(function (a) { if (a.alias.replace(/[.]/g, "").indexOf(q) === 0) add(a.name, 1, a.alias); });
    folded.forEach(function (c) {
      var words = c.key.split(/[\s-]+/);
      for (var i = 1; i < words.length; i++) {
        if (words[i].indexOf(q) === 0) { add(c.name, 2); break; }
      }
    });
    if (!out.length) {
      folded.forEach(function (c) {
        if (fuzzyStart(q, c.key)) add(c.name, c.key.charAt(0) === q.charAt(0) ? 3 : 5);
      });
      aliasList.forEach(function (a) { if (fuzzyStart(q, a.alias)) add(a.name, a.alias.charAt(0) === q.charAt(0) ? 3 : 5); });
    }
    if (q.length >= 3) {
      folded.forEach(function (c) { if (c.key.indexOf(q) > 0) add(c.name, 4); });
    }
    out.sort(function (x, y) {
      if (x.tier !== y.tier) return x.tier - y.tier;
      var px = POPULAR.indexOf(x.name), py = POPULAR.indexOf(y.name);
      if (px !== py && (px >= 0 || py >= 0) && x.tier >= 3) return (px < 0 ? 999 : px) - (py < 0 ? 999 : py);
      return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
    });
    return out;
  }

  window.BLCountries = { NAMES: NAMES, POPULAR: POPULAR, ALIASES: ALIASES, canonical: canonical, search: search, fold: fold };
})();
