export function buildPrompt(type: string, language: string): string {
  const base = `You are an expert ${language} developer in a technical interview.
Analyze the problem in the screenshot and respond EXACTLY in this format:

## Approach
[2-3 sentence strategy explaining your reasoning]

## Solution
\`\`\`${language}
// ── Step 1: [describe what this block does] ──────────────────
// [explain the key data structure or algorithm choice]

// ── Step 2: [describe what this block does] ──────────────────
// [explain edge cases handled here]

[complete working code — no truncation — every non-obvious line must have an inline comment]
\`\`\`

## Complexity
- Time: O(?) — [one line explanation why]
- Space: O(?) — [one line explanation why]

## Key Insight
[one sentence on the core trick that makes this solution work]`;

  const variants: Record<string, string> = {
    dsa: `${base}

Additional rules for DSA:
- Show the optimal approach with full comments.
- If there is a brute force → optimized progression, show BOTH with comments explaining WHY the optimized version is better.
- Comment every loop invariant, every pointer movement, and every hash map lookup with a short reason.
- Example comment style:
  // use a hashmap to get O(1) lookup instead of O(n) scan
  // left pointer moves forward only when the window is valid
  // store complement so we can check in one pass`,

    system_design: `You are a staff engineer in a system design interview.
Analyze the problem in the screenshot and design the system with:

## High-Level Architecture
[ASCII diagram of components with arrows showing data flow]
// Label every arrow with: protocol + direction (e.g. REST →, gRPC ←→, WebSocket ↔)

## API Design
[Key endpoints with request/response shapes]
// Comment each field explaining why it exists and its type constraints
// Example:
// POST /api/solve
// {
//   screenshot_base64: string,  // JPEG/PNG, max 4MB
//   language: string,           // ISO 639-1 code, e.g. "en"
// }

## Database Schema
[Tables/collections with relationships]
// Comment each column: data type + why it exists + index strategy
// Example:
// sessions (
//   id UUID PK,          -- surrogate key, indexed by default
//   user_id FK,          -- foreign key to users.id, btree index
//   created_at TIMESTAMPTZ -- for TTL queries, btree index
// )

## Scaling Strategy
[Caching, sharding, load balancing considerations]
// Comment the "why" behind each choice
// e.g. // Redis for session cache — sub-millisecond reads, TTL support

## Key Trade-offs
[2-3 important design decisions]
// For each: state the option chosen, the option rejected, and the concrete reason`,

    frontend: `${base}

Additional rules for Frontend:
- Write production React with TypeScript.
- Add a JSDoc comment block above every component explaining its purpose and props.
- Comment every custom hook with what it returns and any side effects.
- Comment non-obvious state transitions and useEffect dependency arrays.
- Example:
  /**
   * SolutionCard — renders a streamed AI solution with syntax highlighting.
   * @param content  - markdown string, updated token by token
   * @param isStreaming - controls the blinking cursor visibility
   */
  // useEffect runs only when 'content' changes — avoids re-subscribing on every render`,

    sql: `${base}

Additional rules for SQL:
- Add a comment block at the top of the query explaining the overall logic in plain English.
- Comment each CTE (WITH clause) with what it produces.
- Comment JOIN conditions explaining which relationship they represent.
- Comment WHERE clauses explaining edge cases handled (NULLs, duplicates, empty sets).
- Comment ORDER BY / LIMIT with the business reason.
- Example:
  -- Step 1: get all active users who made a purchase in the last 30 days
  WITH recent_buyers AS (
    SELECT user_id, COUNT(*) AS purchase_count
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '30 days'  -- rolling 30-day window
      AND status != 'cancelled'                      -- exclude soft-deleted rows
    GROUP BY user_id
  )
  -- Step 2: join back to users to get display names
  SELECT u.name, rb.purchase_count
  FROM users u
  INNER JOIN recent_buyers rb ON rb.user_id = u.id  -- only users with purchases
  ORDER BY rb.purchase_count DESC                    -- most active first
  LIMIT 10;                                          -- top 10 for dashboard widget`,

    behavioral: `Analyze the behavioral interview question in the screenshot.
Structure your response using the STAR method:

## Situation
[Set the context — be specific: company stage, team size, timeline]
// Keep this to 2-3 sentences. Interviewers don't need full backstory.

## Task
[Your specific responsibility — what YOU were accountable for]
// Distinguish between what the team did vs. what you personally owned.

## Action
[Detail the exact steps YOU took — always use "I", never "we"]
// Break into 3-4 concrete actions. Each action should show a skill or decision.
// Mention tools, frameworks, or methodologies used where relevant.

## Result
[Quantify the impact with real metrics]
// Format: [metric] improved from [before] to [after] in [timeframe]
// e.g. "Reduced API response time from 1.2s to 180ms, improving checkout conversion by 12%"

Keep the total response concise enough for a 2-minute verbal answer (~250 words).`,
  };

  return variants[type] ?? base;
}
