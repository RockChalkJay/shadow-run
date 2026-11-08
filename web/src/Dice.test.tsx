import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Die } from "./Dice";
import { RulesContext } from "./rules";

describe("a die", () => {
  it("lights as a hit from the minimum the server gives, not a fixed number", () => {
    const { container } = render(
      <RulesContext.Provider value={{ hitMinimum: 4, stunOverflowPerPhysical: 1 }}>
        <Die face={4} />
        <Die face={3} />
      </RulesContext.Provider>,
    );
    const [four, three] = container.querySelectorAll(".die");
    expect(four?.className).toContain("hit");
    expect(three?.className).not.toContain("hit");
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("uses the book's minimum, 5, until it is told otherwise", () => {
    const { container } = render(<><Die face={5} /><Die face={4} /></>);
    const [five, four] = container.querySelectorAll(".die");
    expect(five?.className).toContain("hit");
    expect(four?.className).not.toContain("hit");
  });
});
