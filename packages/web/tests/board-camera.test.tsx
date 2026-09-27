// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampCamera, useBoardCamera } from "../src/hooks/useBoardCamera.js";
import type { PointerEvent } from "react";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("board camera", () => {
  it("keeps zoom and pan inside the island bounds", () => {
    expect(clampCamera(999, -999, 8, 12, 10)).toEqual({
      x: 12,
      y: -10,
      scale: 3,
    });
    expect(clampCamera(5, 5, 0.5, 12, 10)).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it("measures screen targets, pans, pinches, suppresses drag clicks, and fits again", () => {
    let resize: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const hook = renderHook(({ key }) => useBoardCamera(12, 10, key), {
      initialProps: { key: "first" },
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setPointerCapture = vi.fn();
    svg.getBoundingClientRect = () => ({ width: 600, height: 500 }) as DOMRect;
    hook.result.current.svgRef.current = svg;
    // Recreate sizing observer after a board geometry change.
    hook.unmount();
    const mounted = renderHook(() => {
      const camera = useBoardCamera(12, 10, "same");
      camera.svgRef.current = svg;
      return camera;
    });
    act(() => resize());
    expect(mounted.result.current.unitPerPixel).toBe(0.02);
    const pointer = (id: number, x: number, y: number, button = 0) =>
      ({
        pointerId: id,
        clientX: x,
        clientY: y,
        button,
        target: svg,
        currentTarget: svg,
      }) as unknown as PointerEvent<SVGSVGElement>;
    act(() => mounted.result.current.onPointerMove(pointer(1, 50, 50)));
    act(() => mounted.result.current.onPointerDown(pointer(1, 0, 0, 2)));
    act(() => mounted.result.current.zoom(2));
    act(() => mounted.result.current.onPointerDown(pointer(1, 100, 100)));
    act(() => mounted.result.current.onPointerMove(pointer(1, 150, 125)));
    expect(mounted.result.current.camera).toEqual({ x: 1, y: 0.5, scale: 2 });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    mounted.result.current.onClickCapture(click as never);
    expect(click.preventDefault).toHaveBeenCalledOnce();
    act(() => mounted.result.current.onPointerDown(pointer(2, 200, 125)));
    act(() => mounted.result.current.onPointerMove(pointer(2, 250, 125)));
    expect(mounted.result.current.camera.scale).toBe(3);
    act(() => mounted.result.current.onPointerUp(pointer(1, 150, 125)));
    act(() => mounted.result.current.onPointerUp(pointer(2, 250, 125)));
    act(() => mounted.result.current.fit());
    expect(mounted.result.current.camera).toEqual({ x: 0, y: 0, scale: 1 });
    click.preventDefault.mockClear();
    act(() => mounted.result.current.onPointerDown(pointer(3, 0, 0)));
    act(() => mounted.result.current.onPointerUp(pointer(3, 0, 0)));
    mounted.result.current.onClickCapture(click as never);
    expect(click.preventDefault).not.toHaveBeenCalled();
    mounted.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it("resets the camera when a different match replaces the board", () => {
    const hook = renderHook(({ key }) => useBoardCamera(12, 10, key), {
      initialProps: { key: "first" },
    });
    act(() => hook.result.current.zoom(2));
    hook.rerender({ key: "second" });
    expect(hook.result.current.camera.scale).toBe(1);
  });
});
