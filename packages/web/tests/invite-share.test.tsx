// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InviteShare } from "../src/components/invite-share.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const url = "https://island.example/?room=ABC123";
it("uses native sharing and keeps cancellations quiet", async () => {
  const share = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
  const writeText = vi.fn();
  vi.stubGlobal("navigator", { share, clipboard: { writeText } });
  const close = vi.fn();
  render(<InviteShare code="ABC123" url={url} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Share invite" }));
  await waitFor(() =>
    expect(share).toHaveBeenCalledWith({
      title: "Join my Colonizt table",
      text: "Room ABC123",
      url,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Share invite" }));
  await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close invite" }));
  expect(close).toHaveBeenCalledOnce();
});
it("falls back from a failed native share to clipboard, then to a selectable link", async () => {
  const share = vi.fn().mockRejectedValue(new Error("Unavailable"));
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Denied"));
  vi.stubGlobal("navigator", { share, clipboard: { writeText } });
  render(<InviteShare code="ABC123" url={url} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Share invite" }));
  expect(await screen.findByText(/Invite copied/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(await screen.findByText(/Select the link below/)).toBeInTheDocument();
  const input = screen.getByLabelText("Invite link") as HTMLInputElement;
  fireEvent.focus(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(url.length);
});
it("keeps inviting usable when clipboard and native sharing are unavailable", async () => {
  vi.stubGlobal("navigator", {});
  render(<InviteShare code="ABC123" url={url} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(await screen.findByText(/Select the link below/)).toBeInTheDocument();
  expect(screen.getByLabelText("Invite link")).toHaveValue(url);
});
