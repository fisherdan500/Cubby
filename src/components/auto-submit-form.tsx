"use client";

import { useEffect, useRef, type ComponentProps } from "react";

type AutoSubmitFormProps = ComponentProps<"form"> & {
  debounceMs?: number;
};

export function AutoSubmitForm({ children, debounceMs = 450, onChange, ...props }: AutoSubmitFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  function scheduleSubmit(target: EventTarget | null) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const element = target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    const delayed =
      element?.tagName === "TEXTAREA" ||
      (element?.tagName === "INPUT" && ["", "search", "text"].includes((element as HTMLInputElement).type));
    const delay = delayed ? debounceMs : 0;

    timeoutRef.current = setTimeout(() => {
      formRef.current?.requestSubmit();
    }, delay);
  }

  return (
    <form
      {...props}
      ref={formRef}
      onChange={(event) => {
        onChange?.(event);
        scheduleSubmit(event.target);
      }}
    >
      {children}
    </form>
  );
}
