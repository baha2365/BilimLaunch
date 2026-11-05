/*
 * The fields of study the profile form offers, grouped the way the drop-down
 * shows them. The profile's "field of study" must be one of these names (or one
 * of the SYNONYMS below, which are stored under the official name), exactly like
 * the country lists. The matcher (scraper/match.py) compares the saved name with
 * the programme names on each university's pages, so names are written the way
 * universities write them: "Mechanical Engineering", not "Mech Eng".
 *
 * To add a field: add the name to a group in GROUPS, and optionally list other
 * ways people write it under SYNONYMS. Names never contain a comma.
 *
 * The browser has its own copy in frontend/fields.js; `node check_fields.js`
 * checks that the data in both is identical. Run it after editing either file.
 */

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

/** lower-case, no accents, "&" read as "and", every other symbol a single space */
function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const NAMES = GROUPS.flatMap((group) => group.fields);

const BY_NAME = new Map(NAMES.map((name) => [fold(name), name]));
const BY_ALIAS = new Map();
for (const [name, aliases] of Object.entries(SYNONYMS)) {
  for (const alias of aliases) {
    const key = fold(alias);
    if (!BY_NAME.has(key) && !BY_ALIAS.has(key)) BY_ALIAS.set(key, name);
  }
}

/** The official spelling for a field typed in any common way, or null if it is not a field we know. */
function canonical(value) {
  const key = fold(value);
  if (!key) return null;
  return BY_NAME.get(key) || BY_ALIAS.get(key) || null;
}

module.exports = { FIELDS_OF_STUDY: NAMES, GROUPS, POPULAR, SYNONYMS, canonical, fold };