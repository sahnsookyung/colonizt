import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";

export const useSyncedRef = <T>(value: T): MutableRefObject<T> => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
};
