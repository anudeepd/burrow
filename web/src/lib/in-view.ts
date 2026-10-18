import { useEffect, useRef, useState } from "react";

/** One shared IntersectionObserver for every live indicator on the page (hundreds of progress bars -> 1 observer). */
type Cb = (visible: boolean) => void;
const callbacks = new WeakMap<Element, Cb>();
let io: IntersectionObserver | null = null;

function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
  });
  return io;
}

/** Returns [ref, visible]. Loops (pulse, shimmer, flowing edges) must key off `visible` so offscreen work costs nothing. */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const o = observer();
    if (!el || !o) {
      setVisible(true);
      return;
    }
    callbacks.set(el, setVisible);
    o.observe(el);
    return () => {
      o.unobserve(el);
      callbacks.delete(el);
    };
  }, []);
  return [ref, visible];
}
