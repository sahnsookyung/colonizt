import { useEffect, useRef, useState, type PointerEvent } from "react";

export const clampCamera = (
  x: number,
  y: number,
  scale: number,
  width: number,
  height: number,
) => {
  const zoom = Math.max(1, Math.min(3, scale));
  const limitX = (width * (zoom - 1)) / 2;
  const limitY = (height * (zoom - 1)) / 2;
  return {
    x: Math.max(-limitX, Math.min(limitX, x)),
    y: Math.max(-limitY, Math.min(limitY, y)),
    scale: zoom,
  };
};

export const useBoardCamera = (
  width: number,
  height: number,
  resetKey: string,
) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [unitPerPixel, setUnitPerPixel] = useState(width / 800);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const suppressClick = useRef(false);
  const distanceMoved = useRef(0);
  const fit = () => setCamera({ x: 0, y: 0, scale: 1 });
  useEffect(() => {
    setCamera({ x: 0, y: 0, scale: 1 });
  }, [resetKey]);
  useEffect(() => {
    const element = svgRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height)
        setUnitPerPixel(Math.max(width / rect.width, height / rect.height));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, [width, height]);
  const zoom = (factor: number) =>
    setCamera((current) =>
      clampCamera(current.x, current.y, current.scale * factor, width, height),
    );
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if (!pointers.current.size) {
      suppressClick.current = false;
      distanceMoved.current = 0;
    }
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    // Capture only the background: capturing a target would redirect its click to the SVG.
    if (!(event.target as Element).closest("[data-board-target]"))
      event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    const others = [...pointers.current.entries()].filter(
      ([id]) => id !== event.pointerId,
    );
    const deltaX = next.x - previous.x,
      deltaY = next.y - previous.y;
    distanceMoved.current += Math.hypot(deltaX, deltaY);
    if (distanceMoved.current > 6 || others.length) {
      suppressClick.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const other = others[0]?.[1];
    const factor = other
      ? Math.hypot(next.x - other.x, next.y - other.y) /
        Math.max(1, Math.hypot(previous.x - other.x, previous.y - other.y))
      : 1;
    setCamera((current) =>
      clampCamera(
        current.x + (deltaX * unitPerPixel) / (other ? 2 : 1),
        current.y + (deltaY * unitPerPixel) / (other ? 2 : 1),
        current.scale * factor,
        width,
        height,
      ),
    );
    pointers.current.set(event.pointerId, next);
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
  };
  return {
    svgRef,
    camera,
    unitPerPixel,
    fit,
    zoom,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onClickCapture: (event: React.MouseEvent) => {
      if (suppressClick.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
};
