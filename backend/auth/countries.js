/*
 * The list of countries the profile form offers (every sovereign state, plus
 * Kosovo, Taiwan, Palestine, the Vatican, Hong Kong and Macau, which students
 * also apply to). Names never contain a comma, because "target countries" is
 * stored as a comma-separated list. The matcher compares these names with the
 * universities' countries, so "United States" / "United Kingdom" are spelled
 * exactly like the university data.
 *
 * The browser has its own copy in frontend/countries.js; a test checks that both
 * lists are identical.
 */
const COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan",
  "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi",
  "Cambodia", "Cameroon", "Canada", "Cape Verde", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia",
  "Denmark", "Djibouti", "Dominica", "Dominican Republic", "DR Congo",
  "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia",
  "Fiji", "Finland", "France",
  "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana",
  "Haiti", "Honduras", "Hong Kong", "Hungary",
  "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Ivory Coast",
  "Jamaica", "Japan", "Jordan",
  "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan",
  "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
  "Macau", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
  "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway",
  "Oman",
  "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
  "Qatar",
  "Republic of the Congo", "Romania", "Russia", "Rwanda",
  "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria",
  "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
  "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan",
  "Vanuatu", "Vatican City", "Venezuela", "Vietnam",
  "Yemen",
  "Zambia", "Zimbabwe",
];

/** Other ways people write a country: alias -> official name above. */
const ALIASES = {
  "usa": "United States", "us": "United States", "u.s.": "United States", "u.s.a.": "United States", "america": "United States", "united states of america": "United States",
  "uk": "United Kingdom", "u.k.": "United Kingdom", "britain": "United Kingdom", "great britain": "United Kingdom", "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom", "northern ireland": "United Kingdom",
  "uae": "United Arab Emirates", "emirates": "United Arab Emirates",
  "holland": "Netherlands", "the netherlands": "Netherlands",
  "turkiye": "Turkey",
  "czech republic": "Czechia",
  "burma": "Myanmar",
  "cote d'ivoire": "Ivory Coast", "cote divoire": "Ivory Coast",
  "democratic republic of the congo": "DR Congo", "democratic republic of congo": "DR Congo", "drc": "DR Congo", "congo-kinshasa": "DR Congo",
  "congo-brazzaville": "Republic of the Congo", "congo": "Republic of the Congo",
  "russian federation": "Russia",
  "swaziland": "Eswatini",
  "east timor": "Timor-Leste",
  "cabo verde": "Cape Verde",
  "macedonia": "North Macedonia",
  "vatican": "Vatican City", "holy see": "Vatican City",
  "republic of korea": "South Korea", "korea": "South Korea",
  "viet nam": "Vietnam",
  "lao": "Laos",
  "syrian arab republic": "Syria",
  "brunei darussalam": "Brunei",
  "the gambia": "Gambia", "the bahamas": "Bahamas",
  "palestinian territories": "Palestine", "state of palestine": "Palestine",
  "st lucia": "Saint Lucia", "st. lucia": "Saint Lucia", "st kitts and nevis": "Saint Kitts and Nevis", "st. kitts and nevis": "Saint Kitts and Nevis", "st vincent and the grenadines": "Saint Vincent and the Grenadines",
  "prc": "China", "peoples republic of china": "China",
  "hong kong sar": "Hong Kong", "macao": "Macau",
  "kyrgyz republic": "Kyrgyzstan",
  "bosnia": "Bosnia and Herzegovina",
  "trinidad": "Trinidad and Tobago",
  "png": "Papua New Guinea",
};

/** lower-case, no accents, no stray punctuation or spaces */
function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const BY_NAME = new Map(COUNTRIES.map((name) => [fold(name), name]));
const BY_ALIAS = new Map(Object.entries(ALIASES).map(([alias, name]) => [fold(alias), name]));

/** The official spelling for a country typed in any common way, or null if it is not a country we know. */
function canonical(value) {
  const key = fold(value);
  if (!key) return null;
  return BY_NAME.get(key) || BY_ALIAS.get(key) || null;
}

module.exports = { COUNTRIES, ALIASES, canonical, fold };
