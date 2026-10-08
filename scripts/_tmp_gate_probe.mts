import { evaluateInterviewTurn } from "../src/lib/interviewAgent";
const q1 = "Why did you choose this approach?";
const q2 = "What is the time complexity of your approach?";
for (const finals of [[q1], [q2], [q1, q2]]) {
  const t = { finals: finals.map((t) => ({ source: "system" as const, text: t })), interim: null };
  console.log(JSON.stringify(finals), "->", JSON.stringify(evaluateInterviewTurn(t)));
}
