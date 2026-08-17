/**
 * What the model is told about a question the analyst could not answer.
 *
 * The run starts from scratch on every round — nothing carries across but this
 * turn — so a fact that is not written here does not exist as far as the
 * analysis is concerned. That made an unanswered clarifying question invisible:
 * filtered client-side, filtered again on the way in, and absent from the turn.
 * Silence is indistinguishable from never having asked, and the two are not the
 * same thing. A senior analyst declining to assert a material fact is evidence,
 * and the interface had been promising to carry it into the determination as a
 * stated assumption all along.
 */

import { describe, expect, it } from "vitest";
import { buildUserTurn } from "./prompt";

const base = {
  mode: "DESCRIPTION" as const,
  input: "Stainless steel vacuum-insulated bottle",
  htsusRevision: "2026 HTS Revision 15",
  revisionPublished: "2026-07-28",
};

describe("buildUserTurn", () => {
  it("passes on the answers it was given", () => {
    const turn = buildUserTurn({
      ...base,
      refinements: [
        {
          questionId: "q1",
          question: "What is the body made of?",
          answer: "18/8 stainless steel",
        },
      ],
    });

    expect(turn).toContain("What is the body made of?");
    expect(turn).toContain("18/8 stainless steel");
    expect(turn).toContain("do not re-ask what has been answered");
  });

  it("says a question was asked and could not be answered", () => {
    const turn = buildUserTurn({
      ...base,
      refinements: [
        {
          questionId: "q1",
          question: "Is the cavity evacuated or foam-filled?",
          answer: "",
          declined: true,
        },
      ],
    });

    expect(turn).toContain("Is the cavity evacuated or foam-filled?");
    expect(turn).toContain("could not establish the answer");
    // The three things that make a declination useful rather than merely
    // recorded: proceed, say what you assumed, and do not present a coin-flip
    // as settled.
    expect(turn).toContain("name that assumption explicitly");
    expect(turn).toContain("lower your confidence");
    expect(turn).toContain("info_that_would_raise_confidence");
  });

  it("does not re-ask a question the analyst has already declined", () => {
    const turn = buildUserTurn({
      ...base,
      refinements: [
        { questionId: "q1", question: "Origin?", answer: "", declined: true },
      ],
    });
    expect(turn).toContain("Do not re-ask them");
  });

  it("separates the answered from the declined", () => {
    const turn = buildUserTurn({
      ...base,
      refinements: [
        { questionId: "q1", question: "Material?", answer: "Steel" },
        { questionId: "q2", question: "End use?", answer: "", declined: true },
      ],
    });

    // A declined question listed under "the analyst has answered" would tell
    // the model the opposite of the truth.
    const answeredAt = turn.indexOf("has answered your earlier questions");
    const declinedAt = turn.indexOf("could not establish the answer");
    expect(answeredAt).toBeGreaterThan(-1);
    expect(declinedAt).toBeGreaterThan(answeredAt);
    expect(turn.slice(answeredAt, declinedAt)).not.toContain("End use?");
  });

  it("says nothing about refinements on a first run", () => {
    const turn = buildUserTurn({ ...base, refinements: [] });
    expect(turn).not.toContain("has answered");
    expect(turn).not.toContain("could not establish");
  });
});
