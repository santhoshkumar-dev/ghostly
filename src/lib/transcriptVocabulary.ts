/**
 * Vocabulary sources for the open-world ASR repair engine.
 *
 * ── The single most important design rule in this file ─────────────────────
 * `GENERAL_TECH_TERMS` is a *candidate generation* source, NOT a topic
 * whitelist. The interviewer may ask about anything; a term being absent from
 * this list (or from the candidate's profile) must never make a transcript
 * "unrecognised" or un-correctable. Terms here exist only so the scorer has
 * concrete strings to compare a suspicious span against. The absence of
 * "Kubernetes" from a resume must not block hearing it, and the presence of
 * "Spring Boot" in a resume must not force it.
 *
 * Likewise `COMMON_ENGLISH_WORDS` / `COMMON_PHRASES` are used as a *keep raw*
 * prior ("this span is already plausible English, leave it alone"), never as a
 * list of permitted topics.
 */

/**
 * A broad, deliberately non-exhaustive seed of technical/proper terms used for
 * candidate generation. The list is open-ended on purpose: adding a term only
 * makes the engine able to *consider* it, and a correction still requires
 * phonetic + contextual evidence, so precision is not sacrificed.
 */
export const GENERAL_TECH_TERMS: readonly string[] = [
  // Languages
  "JavaScript", "TypeScript", "Java", "Python", "C++", "C#", "Go", "Rust",
  "Kotlin", "Swift", "Ruby", "PHP", "Scala", "Dart", "Elixir", "Perl",
  // Frontend
  "React", "React Native", "Next.js", "Angular", "Vue", "Svelte", "Solid",
  "Redux", "Zustand", "Tailwind", "Webpack", "Vite", "Babel", "ESLint",
  "Virtual DOM", "JSX", "useEffect", "useState", "useMemo", "useCallback",
  "useRef", "useReducer", "useContext",
  // Backend / frameworks
  "Node.js", "Express.js", "NestJS", "FastAPI", "Django", "Flask", "Spring",
  "Spring Boot", "Spring MVC", "Hibernate", "Quarkus", "Micronaut", "Rails",
  "Laravel", ".NET", "ASP.NET", "gRPC", "GraphQL", "REST API", "WebSockets",
  "WebSocket", "OAuth", "OIDC", "JWT", "SSO", "SAML", "OpenAPI", "Swagger",
  // Databases / storage
  "MongoDB", "PostgreSQL", "Postgres", "MySQL", "SQLite", "Redis", "Cassandra",
  "DynamoDB", "Firestore", "Elasticsearch", "OpenSearch", "ClickHouse",
  "Neo4j", "MariaDB", "Oracle Database", "Snowflake", "BigQuery", "Redshift",
  // Messaging / streaming
  "Kafka", "RabbitMQ", "Rabbit MQ", "SQS", "SNS", "Pub/Sub", "NATS", "MQTT",
  "ActiveMQ", "ZeroMQ",
  // DevOps / infra / cloud
  "Docker", "Kubernetes", "Helm", "Terraform", "Ansible", "Pulumi", "ArgoCD",
  "Argo CD", "Jenkins", "GitHub Actions", "GitLab CI", "CircleCI", "CI/CD",
  "Prometheus", "Grafana", "Datadog", "New Relic", "Sentry", "Splunk",
  "AWS", "Azure", "GCP", "Google Cloud", "Lambda", "EC2", "S3", "EKS", "ECS",
  "CloudFront", "Cloudflare", "Nginx", "Apache", "Kong", "Istio", "Linkerd",
  "Serverless", "OpenShift", "Vercel", "Netlify", "Heroku", "Railway",
  // Concepts
  "Dependency Injection", "Inversion of Control", "Microservices",
  "Monolith", "Load Balancer", "Rate Limiter", "Caching", "Sharding",
  "Replication", "Consistency", "Availability", "Partition Tolerance",
  "CAP Theorem", "ACID", "BASE", "Idempotency", "Circuit Breaker",
  "Message Queue", "Event Sourcing", "CQRS", "SOLID", "MVC", "MVVM",
  "REST", "GraphQL API", "Webhook", "Middleware", "ORM", "Repository Pattern",
  "Design Pattern", "Singleton", "Factory", "Observer", "Strategy",
  "Recursion", "Big O", "Time Complexity", "Space Complexity", "Hash Map",
  "Linked List", "Binary Tree", "Heap", "Dynamic Programming", "Greedy",
  "Binary Search", "Graph", "Trie", "Memoization",
  // Auth / security
  "Authentication", "Authorization", "RBAC", "Encryption", "Hashing",
  "Salt", "CSRF", "XSS", "CORS", "TLS", "HTTPS", "Bearer Token",
  // Data / ML
  "Pandas", "NumPy", "PyTorch", "TensorFlow", "scikit-learn", "Spark",
  "Hadoop", "Airflow", "dbt", "ETL", "Data Warehouse", "Data Lake",
  // Tooling
  "Git", "GitHub", "GitLab", "Bitbucket", "Jira", "Confluence", "Postman",
  "Maven", "Gradle", "npm", "Yarn", "pnpm", "Bun", "WebAssembly",
];

/**
 * High-frequency English words used as a *keep-raw* prior.
 *
 * Curated to the most common ~few-hundred words. The point is not coverage but
 * discrimination: a span built entirely of these words is assumed to already be
 * what the interviewer said. `water` and `spring` are here; `wood` is
 * deliberately not, because "spring wood" is not a plausible English phrase
 * while "spring water" is.
 */
const COMMON_ENGLISH_WORD_LIST: readonly string[] = [
  // function words
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "as", "so",
  "of", "to", "in", "on", "at", "by", "for", "from", "with", "without",
  "about", "into", "over", "under", "between", "during", "before", "after",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does",
  "did", "doing", "have", "has", "had", "can", "could", "would", "will",
  "should", "shall", "may", "might", "must", "not", "no", "yes", "this",
  "that", "these", "those", "it", "its", "he", "she", "they", "them",
  "we", "us", "you", "your", "yours", "i", "me", "my", "mine", "our",
  "ours", "his", "her", "their", "there", "here", "where", "when", "why",
  "how", "what", "which", "who", "whom", "whose", "all", "any", "some",
  "each", "every", "both", "few", "more", "most", "much", "many", "very",
  "really", "just", "only", "also", "too", "again", "still", "already",
  "now", "then", "one", "two", "three", "first", "second", "next", "last",
  "other", "another", "same", "different", "such", "like", "well", "good",
  "great", "better", "best", "bad", "new", "old", "big", "small", "long",
  "short", "high", "low", "right", "left", "true", "false", "sure", "okay",
  "right", "please", "thanks", "thank", "hello", "hi", "hey", "yeah", "yep",
  "nope", "hmm", "um", "uh", "actually", "basically", "maybe", "perhaps",
  // verbs
  "tell", "said", "say", "says", "ask", "asked", "explain", "describe",
  "walk", "talk", "give", "show", "make", "made", "take", "took", "get",
  "got", "go", "going", "gone", "come", "came", "see", "saw", "seen",
  "know", "knew", "known", "think", "thought", "want", "wanted", "need",
  "needed", "use", "used", "using", "work", "worked", "working", "build",
  "built", "building", "create", "created", "creating", "design", "designed",
  "implement", "implemented", "write", "wrote", "written", "read", "run",
  "running", "solve", "solved", "choose", "chose", "chosen", "pick",
  "picked", "start", "started", "stop", "stopped", "begin", "began", "end",
  "ended", "find", "found", "lose", "lost", "help", "helped", "keep",
  "kept", "let", "put", "set", "add", "added", "remove", "removed",
  "change", "changed", "improve", "improved", "scale", "scaled", "scaling",
  "deploy", "deployed", "debug", "debugging", "handle", "handled",
  "collect", "collected", "invent", "invented", "return", "returns",
  "consider", "explains", "compare", "difference", "differences", "mean",
  "means", "meant", "happen", "happened", "happens", "receive", "received",
  // nouns / adjectives
  "project", "projects", "experience", "work", "job", "company", "team",
  "role", "position", "interview", "question", "questions", "answer",
  "problem", "solution", "system", "systems", "application", "app", "apps",
  "service", "services", "server", "servers", "client", "user", "users",
  "feature", "features", "data", "database", "databases", "table", "tables",
  "file", "files", "code", "coding", "function", "functions", "method",
  "methods", "class", "classes", "object", "objects", "variable", "type",
  "types", "value", "values", "number", "numbers", "string", "strings",
  "list", "lists", "array", "arrays", "map", "set", "key", "value", "text",
  "word", "words", "sentence", "language", "languages", "time", "times",
  "request", "requests", "response", "responses", "error", "errors", "bug",
  "bugs", "issue", "issues", "log", "logs", "test", "tests", "testing",
  "performance", "speed", "memory", "storage", "network", "internet",
  "works", "starts", "returning", "receives", "returns", "deploying",
  "web", "website", "page", "pages", "screen", "frontend", "backend",
  "fullstack", "mobile", "desktop", "cloud", "cache", "queue", "message",
  "messages", "event", "events", "thread", "process", "processes",
  "security", "authentication", "authorization", "injection", "dependency",
  "dependencies", "state", "props", "component", "components", "render",
  "hook", "hooks", "route", "routes", "endpoint", "endpoints", "api",
  "capital", "country", "city", "world", "wide", "water", "spring",
  "summer", "winter", "autumn", "money", "people", "person", "thing",
  "things", "place", "places", "part", "parts", "kind", "ways", "way",
  "year", "years", "day", "days", "night", "morning", "today", "tomorrow",
  "suppose", "imagine", "example", "case", "cases", "reason", "reasons",
  "challenge", "challenges", "approach", "overview", "architecture",
  "suddenly", "thousands", "hundreds", "million", "several", "different",
  "similar", "simple", "complex", "main", "whole", "single", "multiple",
  "real", "actual", "current", "recent", "future", "past", "quick",
  "quickly", "slow", "slowly", "fast", "failure", "failures", "five",
  "hundred", "and", "so", "ok", "you", "them",
];

const COMMON_ENGLISH_WORDS = new Set(COMMON_ENGLISH_WORD_LIST);

/**
 * Common two-word English phrases. A span that is exactly one of these is
 * treated as already-plausible and is never auto-corrected. Kept small and
 * generic ("spring water"), never a topic list.
 */
const COMMON_PHRASE_LIST: readonly string[] = [
  "spring water", "water bottle", "capital city", "world wide web",
  "time complexity", "space complexity", "design pattern", "big o",
  "hash map", "linked list", "binary tree", "binary search",
  "dynamic programming", "database table", "load balancer", "rate limiter",
  "message queue", "event sourcing", "dependency injection", "unit test",
  "integration test", "source code", "open source", "machine learning",
  "deep learning", "neural network", "data science", "operating system",
  "version control", "pull request", "merge conflict", "user experience",
  "user interface", "product manager", "software engineer", "real time",
  "full stack", "front end", "back end", "side project",
];

const COMMON_PHRASES = new Set(COMMON_PHRASE_LIST);

/** Lowercase-collapsed lookup of every known technical term. */
const TECH_TERM_LOOKUP = new Map<string, string>();
for (const term of GENERAL_TECH_TERMS) {
  TECH_TERM_LOOKUP.set(term.toLowerCase(), term);
}
// A handful of common ASR spellings alias onto the canonical term. These are
// candidate *aliases*, not a hardcoded replacement list — scoring still decides.
const ALIASES: Record<string, string> = {
  "node js": "Node.js",
  "nodejs": "Node.js",
  "next js": "Next.js",
  "nextjs": "Next.js",
  "express js": "Express.js",
  "springboot": "Spring Boot",
  "mongo db": "MongoDB",
  mongodb: "MongoDB",
  postgres: "PostgreSQL",
  "post gres": "PostgreSQL",
  "rest api": "REST API",
  "restful api": "REST API",
  "github actions": "GitHub Actions",
  "github action": "GitHub Actions",
  "argo cd": "ArgoCD",
  argocd: "ArgoCD",
  "rabbit mq": "RabbitMQ",
  rabbitmq: "RabbitMQ",
  websocket: "WebSockets",
  websockets: "WebSockets",
  "ci cd": "CI/CD",
  cicd: "CI/CD",
};
for (const [alias, canonical] of Object.entries(ALIASES)) {
  if (!TECH_TERM_LOOKUP.has(alias)) TECH_TERM_LOOKUP.set(alias, canonical);
}

/** Candidate/context vocabulary, extracted from the candidate's own settings. */
export interface CandidateContext {
  /** Canonical terms known to be relevant to this candidate. */
  terms: string[];
}

export const EMPTY_CANDIDATE_CONTEXT: CandidateContext = { terms: [] };

/**
 * Function words (determiners, auxiliaries, prepositions, pronouns, question
 * words). A correction span must never *start* on one of these: the misheard
 * content word is always the anchor, so "is mongo db" is never treated as a
 * single span ("mongo db" is).
 */
const COMMON_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "as",
  "so", "of", "to", "in", "on", "at", "by", "for", "from", "with",
  "without", "about", "into", "over", "under", "between", "during",
  "before", "after", "is", "are", "was", "were", "be", "been", "being",
  "am", "do", "does", "did", "doing", "have", "has", "had", "can",
  "could", "would", "will", "should", "shall", "may", "might", "must",
  "not", "no", "yes", "this", "that", "these", "those", "it", "its",
  "he", "she", "they", "them", "we", "us", "you", "your", "yours",
  "i", "me", "my", "mine", "our", "ours", "his", "her", "their",
  "there", "here", "where", "when", "why", "how", "what", "which",
  "who", "whom", "whose", "all", "any", "some", "each", "every",
  "both", "few", "more", "most", "much", "many", "very", "really",
  "just", "only", "also", "too", "again", "still", "already", "now",
  "then", "please", "let", "lets",
]);

/** True when `token` is a high-frequency English word. */
export function isCommonEnglishWord(token: string): boolean {
  return COMMON_ENGLISH_WORDS.has(token.toLowerCase().replace(/[^a-z0-9']/g, ""));
}

/** True when `token` is a function word (see `COMMON_STOP_WORDS`). */
export function isStopword(token: string): boolean {
  return COMMON_STOP_WORDS.has(token.toLowerCase().replace(/[^a-z0-9']/g, ""));
}

/** True when the exact lowercased phrase is a known common English phrase. */
export function isCommonPhrase(text: string): boolean {
  return COMMON_PHRASES.has(text.toLowerCase().replace(/\s+/g, " ").trim());
}

/**
 * Whether a term has a *stylized* canonical spelling — an acronym run
 * ("REST API", "RabbitMQ", "PostgreSQL") or a brand spelling with a symbol or
 * internal capital ("Node.js", "CricAuctionHub"). Only such terms are allowed
 * to override casing/spacing when the letters already match. Plain Title Case
 * ("Dependency Injection", "Spring Boot") is not — there is no evidence the
 * interviewer meant anything other than the ordinary lowercase words.
 */
export function isStylizedTerm(term: string): boolean {
  if (/[A-Za-z][A-Za-z0-9]*[^A-Za-z0-9 ][A-Za-z0-9]/.test(term)) return true; // Node.js
  if (/[A-Z]{2,}/.test(term)) return true; // REST, API, DB, SQL, MQ
  if (/[a-z][A-Z]/.test(term)) return true; // CamelCase / internal capital
  return false;
}

/** Canonical technical term for a lowercased exact match, if any. */
export function knownTechTerm(text: string): string | null {
  const key = text.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return TECH_TERM_LOOKUP.get(key) ?? null;
}

/** All canonical terms in the general vocabulary (deduplicated). */
export function allTechTerms(): string[] {
  return Array.from(new Set(TECH_TERM_LOOKUP.values()));
}

/**
 * Extract candidate terms from the interview settings. Everything here is a
 * *boost*, never a whitelist: the correction engine works with an empty context.
 *
 * Sources: company name, chosen language/skill, and entities recognised in the
 * resume / job description (known tech terms plus CamelCase / numbered project
 * names). The full resume is never stored on the context — only short terms.
 */
export function buildCandidateContext(settings: {
  companyName?: string;
  language?: string;
  interviewType?: string;
  resumeText?: string;
  jobDescription?: string;
}): CandidateContext {
  // Memoized on object identity: the store returns the same settings object
  // until it changes, so scanning a 20k-char resume happens once, not per final.
  const cached = CONTEXT_MEMO.get(settings);
  if (cached) return cached;
  const built = extractCandidateContext(settings);
  CONTEXT_MEMO.set(settings, built);
  return built;
}

const CONTEXT_MEMO = new WeakMap<object, CandidateContext>();

function extractCandidateContext(settings: {
  companyName?: string;
  language?: string;
  interviewType?: string;
  resumeText?: string;
  jobDescription?: string;
}): CandidateContext {
  const terms = new Set<string>();

  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 60) return;
    terms.add(trimmed);
  };

  if (settings.companyName) {
    for (const word of settings.companyName.split(/\s+/)) add(word);
  }
  if (settings.language) add(settings.language);

  const text = `${settings.resumeText ?? ""}\n${settings.jobDescription ?? ""}`;

  // Known tech terms mentioned anywhere in the profile.
  const lower = text.toLowerCase();
  for (const term of allTechTerms()) {
    if (lower.includes(term.toLowerCase())) terms.add(term);
  }

  // Project / product / company names: CamelCase, embedded capitals, digits,
  // or all-caps acronyms of length >= 3.
  const entityPattern =
    /\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Z]{3,}|[A-Za-z]*\d[A-Za-z0-9]*)\b/g;
  for (const match of text.matchAll(entityPattern)) add(match[0]);

  return { terms: Array.from(terms) };
}
