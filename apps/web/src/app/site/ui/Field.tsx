import React, { useId } from "react";

import { cx, FOCUS_RING, LABEL } from "./styles";

const CONTROL =
  "w-full min-w-0 border-[3px] border-[#1A1A1A] bg-white px-3 py-2.5 text-[15px] text-[#1A1A1A] placeholder:text-[#6B7280] transition-shadow focus:shadow-[3px_3px_0_#0052FF] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#F1F5F9] dark:placeholder:text-[#64748B] dark:focus:shadow-[3px_3px_0_#FFD60A] disabled:opacity-60";

interface FieldShellProps {
  readonly label: React.ReactNode;
  readonly hint?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly className?: string;
  readonly children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => React.ReactNode;
}

function FieldShell({ label, hint, error, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cx(LABEL, "text-[#1A1A1A] dark:text-[#E2E8F0]")}>
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-xs text-[#45464B] dark:text-[#A9B6C8]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> & {
  readonly label: React.ReactNode;
  readonly hint?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly containerClassName?: string;
  readonly mono?: boolean;
};

export function TextField({ label, hint, error, containerClassName, className, mono, ...rest }: InputProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={containerClassName}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cx(CONTROL, FOCUS_RING, mono && "font-code text-[13px]", className)}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

type TextAreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  readonly label: React.ReactNode;
  readonly hint?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly containerClassName?: string;
  readonly mono?: boolean;
};

export function TextAreaField({ label, hint, error, containerClassName, className, mono, ...rest }: TextAreaProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={containerClassName}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cx(CONTROL, FOCUS_RING, "resize-y", mono && "font-code text-[13px]", className)}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  readonly label: React.ReactNode;
  readonly hint?: React.ReactNode;
  readonly error?: React.ReactNode;
  readonly containerClassName?: string;
  readonly options: readonly { value: string; label: string }[];
};

export function SelectField({ label, hint, error, containerClassName, className, options, ...rest }: SelectProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={containerClassName}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cx(CONTROL, FOCUS_RING, "cursor-pointer font-semibold", className)}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
