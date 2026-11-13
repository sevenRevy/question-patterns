import type { PatternExample } from './domain';

// Original, cross-subject illustrations. Stable IDs let core updates preserve learner edits.
function examples(patternNumber: number, questions: string[]): PatternExample[] {
  return questions.map((text, index) => ({
    id: `10000000-0000-4000-8000-${String(patternNumber * 100 + index + 1).padStart(12, '0')}`,
    text,
    forced: false,
  }));
}

export const CORE_EXAMPLES: Record<number, PatternExample[]> = {
  1: examples(1, [
    `Question: A rectangular noticeboard measures 1.2 m by 0.8 m. What is its area in square metres?

Answer: 0.96 m².
Rationale: Area = length × width = 1.2 × 0.8 = 0.96.`,
    `Question: Give the correct simple-present form of “sit” to complete the sentence: “The collection of maps ___ on the top shelf.”

Answer: sits.
Rationale: “Collection” is the singular subject, so it takes the singular verb “sits.” The plural noun “maps” is part of a modifying phrase and does not change the subject’s number.`,
    `Question: A sealed jar contains water vapor. After the jar is cooled, liquid droplets appear on its inner wall. What change of state formed the droplets?

Answer: Condensation.
Rationale: Water changed from gas to liquid.`,
  ]),
  2: examples(2, [
    `Question: What is 3/4 of 28? Select one answer.
A. 7
B. 14
C. 21
D. 28

Answer: C. 21.
Rationale: 28 ÷ 4 = 7, and 7 × 3 = 21.`,
    `Question: Choose the sentence that uses “its” or “it’s” correctly.
A. The dog wagged it's tail.
B. It's collar was red.
C. The dog wagged its tail.
D. The dog wagged its' tail.

Answer: C. The dog wagged its tail.
Rationale: “Its” is the possessive form; “it’s” means “it is” or “it has,” and “its’” is not a standard form.`,
    `Question: A metal spoon and a wooden spoon have reached the same room temperature. Why can the metal spoon feel cooler to your hand? Select the best explanation.
A. Metal transfers heat from your hand faster.
B. Being metal makes its temperature lower than room temperature.
C. Wood transfers heat away from your hand faster.

Answer: A.
Rationale: Metal conducts heat away from warmer skin faster even when both spoons have the same temperature.`,
  ]),
  3: examples(3, [
    `Question: Evaluate I–III and select the option listing all and only the true statements.
I. 12 is divisible by 3.
II. 15 is even.
III. 7 + 5 = 12.
A. I only
B. I and III only
C. I, II, and III

Answer: B.
Rationale: I and III are true; II is false because 15 is odd.`,
    `Question: Use standard English subject–verb agreement. Select the option listing all and only the true statements.
I. “We were ready” has standard subject–verb agreement.
II. “They was ready” has standard subject–verb agreement.
A. I only
B. II only
C. I and II

Answer: A. I only.
Rationale: “We” takes “were.” With “they,” the standard past-tense form is also “were,” not “was.”`,
    `Question: The main desk opens at 08:30 and closes at 16:30. The study room opens at 09:00 and closes at 16:00. Select all and only the statements supported by this schedule.
I. The study room opens after the main desk.
II. The main desk closes before the study room.
III. Both are open at 10:00.
A. I only
B. II only
C. I and III only
D. II and III only

Answer: C.
Rationale: I and III follow from the schedule. The main desk closes later, not earlier, than the study room.`,
  ]),
  4: examples(4, [
    `Question: Mark the statement true or false. If false, correct the result: "6 × 4 = 22."

Answer: False; 6 × 4 = 24.
Rationale: Six groups of four total 24.`,
    `Question: Mark the statement true or false: In the sentence “The letters arrive every morning,” the plural subject “letters” agrees with the verb “arrive.”

Answer: True.
Rationale: In the simple present, a plural subject takes the base verb form “arrive”; a singular subject would take “arrives.”`,
    `Question: A syringe contains trapped air, its tip is sealed, and its movable plunger is pushed inward. Mark true or false: "The trapped air now occupies less volume."

Answer: True.
Rationale: Moving the plunger inward compresses the trapped air into a smaller space.`,
  ]),
  5: examples(5, [
    `Question: Match each expression to its value. Use every letter once.
1. 9 ÷ 3
2. 5²
3. 4 + 3
A. 7
B. 3
C. 25

Answer: 1–B, 2–C, 3–A.
Rationale: The expressions evaluate to 3, 25, and 7 respectively.`,
    `Question: Match each quoted word to its part of speech. Use each option once.
1. “carefully” in “Mia carefully folded the map.”
2. “map” in “Mia folded the map.”
A. noun
B. adverb

Answer: 1–B, 2–A.
Rationale: “Carefully” modifies the verb “folded,” while “map” names a thing.`,
    `Question: Match each change of state to its name. Use each option once.
1. Liquid water becomes ice.
2. Water vapor forms droplets on cool glass.
3. An ice cube becomes liquid water.
A. Freezing
B. Condensation
C. Melting

Answer: 1–A, 2–B, 3–C.
Rationale: The changes are liquid to solid, gas to liquid, and solid to liquid.`,
  ]),
  6: examples(6, [
    `Question: Arrange these numbers in increasing order: 0.4, −1, 3/5, 0.

Answer: −1, 0, 0.4, 3/5.
Rationale: 3/5 = 0.6; both positive values exceed zero, and −1 is smallest.`,
    `Question: Arrange the blocks to form a sentence in the order subject → verb → direct object → time expression. Use each block once.
A. yesterday
B. The volunteers
C. delivered
D. the supplies

Answer: B → C → D → A: “The volunteers delivered the supplies yesterday.”
Rationale: The sentence places the subject before the verb, the direct object after the verb, and the time expression at the end.`,
    `Question: Keep a light meter in the same position throughout. Arrange these steps to compare its reading before and after a lamp is switched on.
A. Record the reading with the lamp on.
B. Switch on the lamp.
C. Compare the two readings.
D. Record the reading with the lamp off.
E. Wait 30 seconds after switching on the lamp.

Answer: D → B → E → A → C.
Rationale: Record the baseline first, switch on and wait, then record and compare.`,
  ]),
  7: examples(7, [
    `Question: Complete the statement with a fraction in simplest form: 3/4 + 1/8 = ____.

Answer: 7/8.
Rationale: 3/4 = 6/8, so 6/8 + 1/8 = 7/8.`,
    `Question: Complete the sentence with the simple past form of “finish”: “The students ___ their essays yesterday.”

Answer: finished.
Rationale: “Finished” is the simple past form of “finish” and completes the sentence with the stated time.`,
    `Question: Complete the statement with the name of the substance: An ice cube melts and becomes liquid ____.

Answer: water.
Rationale: Melting changes solid water into liquid water; it does not create a different substance.`,
  ]),
  8: examples(8, [
    `Question: A commuter has a travel budget of 18 credits. One journey costs 5 credits and the return costs 4 credits. How many credits remain after both journeys? Show one calculation.

Answer: 9 credits; 18 − 5 − 4 = 9.
Rationale: Subtract both journey costs from the original budget.`,
    `Question: Read the passage: “At the station, Maya checked the departure board. Her train was delayed by 20 minutes, so she sat down and opened her book.” Why did Maya sit down and open her book? Support your answer with a detail from the passage.

Model answer: Her train was delayed by 20 minutes, so she had time to wait and read.
Rationale: The delay is stated directly and explains why Maya waited; the passage also says that she opened her book.`,
    `Question: You need an ice cube to stay solid during a 15-minute trip. In a trial under the same conditions, a cube in an insulated lunch bag remained solid for 15 minutes, while a cube on a sunny table became liquid. Which tested option fits the goal, and what evidence supports it?

Answer: Use the insulated lunch bag.
Rationale: It is the option that kept the cube solid for the required duration in the trial.`,
  ]),
  9: examples(9, [
    `Question: A student solves 5(x − 2) = 15 with these steps:
1. 5x − 2 = 15
2. 5x = 17
3. x = 3.4
Identify the first incorrect step and give the corrected value of x.

Answer: Step 1 is incorrect. Distribution gives 5x − 10 = 15, so x = 5.
Rationale: The factor 5 must multiply both terms inside the parentheses.`,
    `Question: Identify the subject–verb agreement error and correct the sentence: “The box of donated books were left by the door.”

Answer: “The box of donated books was left by the door.”
Rationale: “Box” is the singular subject. The plural noun “books” is inside a modifying phrase, so the verb must be “was.”`,
    `Question: One plant grew 2 cm during a week when it was watered. A learner concludes: "Watering was the only cause of the growth." Identify the unsupported part and rewrite the conclusion more cautiously.

Answer: "Only cause" is unsupported. A cautious conclusion is: "The plant grew 2 cm during the week it was watered; this observation alone does not establish the cause."
Rationale: A single observation without a controlled comparison cannot isolate one cause.`,
  ]),
  10: examples(10, [
    `Question: Use this table:
Distance (km) | Time (min)
0 | 0
2 | 4
4 | 8
If the same pattern continues, how long would 6 km take? Explain the table pattern used.

Answer: 12 minutes.
Rationale: Each additional 2 km adds 4 minutes.`,
    `Question: Read the report: “In the first week, the school garden produced 8 tomatoes. In the second week, it produced 12. In the third week, it produced 10.” Which week had the highest yield, and how many more tomatoes did it produce than the week with the lowest yield?

Answer: The second week, with 4 more tomatoes than the first week.
Rationale: The second week had the highest total (12), and the first week had the lowest (8); 12 − 8 = 4.`,
    `Question: Use the measured mass of solid ice remaining in this trial:
Location | At start | After 5 minutes
Sunny windowsill | 30 g | 12 g
Shaded shelf | 30 g | 24 g
At which location did the solid ice lose more mass, and by how much more?

Answer: The sunny windowsill, by 12 g more.
Rationale: Solid ice decreased by 18 g there and by 6 g on the shaded shelf; 18 − 6 = 12 g.`,
  ]),
  11: examples(11, [
    `Question: A rectangle has perimeter 30 cm and length 9 cm. Using P = 2L + 2W, find its width. Show the equation, include units, and check the result.

Answer: 30 = 2(9) + 2W, so W = 6 cm.
Rationale: 2(9) + 2(6) = 18 + 12 = 30 cm, matching the perimeter.`,
    `Question: Write a reminder of no more than nine words that states both facts: the meeting is at 2 p.m. and the location is Room 3.

Answer: “The meeting is at 2 p.m. in Room 3.”
Rationale: The nine-word reminder includes both the time and the location. Other concise wording that includes both facts is also valid.`,
    `Question: A fair test changes only the condition being studied and keeps other relevant conditions equal. To test whether light affects plant growth, a plan gives Plant A 50 mL of water daily in a sunny place and Plant B 20 mL daily in a shaded place. Identify a necessary change and name other conditions to keep comparable.

Answer: Give both plants the same daily water amount while varying light. Use comparable plants, soil, containers, and observation periods.
Rationale: Changing both light and water prevents the comparison from isolating the effect of light.`,
  ]),
  12: examples(12, [
    `Question: In 1–2 sentences, explain why 2(5 + 3) = 2 × 5 + 2 × 3. Name the rule and use the numbers to support your explanation.

Model answer: The distributive rule makes 2 multiply each term: 2 × 5 + 2 × 3 = 10 + 6 = 16. The left side is also 2 × 8 = 16.
Rationale: The explanation states the rule and verifies it with the supplied values.`,
    `Question: Read the sentence: “Although the road was wet, the race continued.” In 1–2 sentences, explain the relationship introduced by “although,” using both details from the sentence.

Model answer: “Although” introduces a contrast: the road was wet, but the race still continued. The sentence presents the wet road as a possible obstacle that did not stop the race.
Rationale: The explanation identifies the contrast and connects both facts stated in the sentence.`,
    `Question: A room smelled fresher after someone moved a plant into it. At the same time, someone opened a window. In two sentences, explain why this observation alone does not show that the plant caused the change, and name one useful comparison.

Model answer: The open window could also have changed the smell, so the observation does not isolate the plant's effect. Compare similar periods with the window condition kept the same and vary only whether the plant is present.
Rationale: The explanation identifies an alternative cause and proposes a comparison that controls it.`,
  ]),
};
