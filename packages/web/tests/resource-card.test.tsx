// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCard } from "../src/components/game-ui.js";

afterEach(cleanup);

it("keeps unavailable resources focusable without accepting selections", () => {
  const onClick = vi.fn();
  const { rerender } = render(<ResourceCard resource="timber" count={8} onClick={onClick} disabled />);
  const card = screen.getByRole("button", { name: "Timber: 8" });
  expect(card).toHaveAttribute("aria-disabled", "true");
  card.focus();
  expect(card).toHaveFocus();
  fireEvent.click(card);
  expect(onClick).not.toHaveBeenCalled();

  rerender(<ResourceCard resource="timber" count={8} onClick={onClick} />);
  expect(card).toHaveAttribute("aria-disabled", "false");
  fireEvent.click(card);
  expect(onClick).toHaveBeenCalledOnce();
});
