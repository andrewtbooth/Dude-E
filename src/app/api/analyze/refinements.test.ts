/**
 * What the analyst has told the analysis, across rounds.
 *
 * The clarifying-question form submits the answers on screen — the questions
 * *this* round raised. The route treated that as the whole record and wrote it
 * over the stored one, so a second round of questions erased the first round's
 * answers from the database and from the conversation the model was re-run
 * with. The run then reached a classification without a fact it had been given,
 * and the determination printed a refinement list that did not include it.
 *
 * These exercise the merge directly. The route around it needs a session, a
 * database and a live model; the losing of answers does not.
 */

import { describe, expect, it } from "vitest";
import { mergeRefinements, parseRefinements } from "./refinements";

const material = {
  questionId: "q1",
  question: "What is the body made of?",
  answer: "18/8 stainless steel",
};
const endUse = {
  questionId: "q2",
  question: "Is it sold for household use?",
  answer: "Yes, retail housewares",
};

describe("mergeRefinements", () => {
  it("keeps an earlier round's answers when a later round asks new questions", () => {
    expect(mergeRefinements([material], [endUse])).toEqual([material, endUse]);
  });

  it("lets a re-answer replace the answer it corrects", () => {
    const corrected = { ...material, answer: "Aluminium, not steel" };
    expect(mergeRefinements([material], [corrected])).toEqual([corrected]);
  });

  it("preserves the order answers were given in", () => {
    // The determination prints these as the record of the exchange, so the
    // first thing asked should read first.
    const third = { questionId: "q3", question: "Capacity?", answer: "32 oz" };
    expect(
      mergeRefinements([material, endUse], [third]).map((r) => r.questionId),
    ).toEqual(["q1", "q2", "q3"]);
  });

  it("does not let a reused question id swallow a different question", () => {
    // Ids come from the model and are not guaranteed stable across rounds.
    // Keeping two entries for what might be one question loses nothing;
    // collapsing them loses an answer the analyst gave.
    const reused = {
      questionId: "q1",
      question: "Is the vacuum insulation double-walled?",
      answer: "Yes",
    };
    expect(mergeRefinements([material], [reused])).toEqual([material, reused]);
  });

  it("lets a real answer supersede an earlier declination", () => {
    const declined = { ...material, answer: "", declined: true };
    expect(mergeRefinements([declined], [material])).toEqual([material]);
  });

  it("lets a declination supersede an earlier answer", () => {
    // Rarer, but it is a correction like any other: the analyst realises the
    // thing they wrote down was not actually established.
    const declined = { ...material, answer: "", declined: true };
    expect(mergeRefinements([material], [declined])).toEqual([declined]);
  });

  it("is a no-op on a first round", () => {
    expect(mergeRefinements([], [material, endUse])).toEqual([material, endUse]);
  });

  it("keeps the record when a round is submitted with nothing answered", () => {
    // Answering is optional — the form lets an analyst skip every question and
    // proceed on stated assumptions. That must not read as a retraction.
    expect(mergeRefinements([material, endUse], [])).toEqual([material, endUse]);
  });
});

describe("parseRefinements", () => {
  it("keeps an explicit declination", () => {
    // The form promises a blank is carried into the determination as a stated
    // assumption. It was filtered out here, which is where that promise died:
    // an analyst who was asked and could not say became indistinguishable from
    // one who was never asked.
    expect(
      parseRefinements([
        { questionId: "q1", question: "Material?", answer: "", declined: true },
      ]),
    ).toEqual([
      { questionId: "q1", question: "Material?", answer: "", declined: true },
    ]);
  });

  it("still drops an entry that says nothing at all", () => {
    // Neither answered nor declined is not a fact about the product; it is a
    // malformed submission.
    expect(
      parseRefinements([{ questionId: "q1", question: "Material?", answer: "" }]),
    ).toEqual([]);
  });

  it("prefers the answer when both are present", () => {
    expect(
      parseRefinements([
        { questionId: "q1", question: "Material?", answer: "Steel", declined: true },
      ]),
    ).toEqual([{ questionId: "q1", question: "Material?", answer: "Steel" }]);
  });
});
