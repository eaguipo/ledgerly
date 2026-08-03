"use client";

import { useId, useState, type ReactNode } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { CUSTOM_CHOICE, MAX_CUSTOM_LABEL } from "@/lib/custom-choice";

/**
 * A `<select>` whose last entry is "the list doesn't have mine" — picking it
 * reveals a text box for the user's own value.
 *
 * Three fields need this (expense category, account category, income source)
 * and each stores the typed value differently underneath, so the component
 * deliberately owns none of that: it emits the select under `name` and, when
 * the sentinel is chosen, the text box under `custom.name`. Translating that
 * pair into a row is the Server Action's job.
 */

export interface Choice {
  value: string;
  label: string;
}

export function ChoiceWithCustom({
  label,
  name,
  options,
  placeholder,
  defaultValue = "",
  required,
  hint,
  addLabel = "+ Add my own…",
  custom,
  onValueChange,
}: {
  label: ReactNode;
  name: string;
  options: readonly Choice[];
  /** Blank leading option. Omit when the select always starts on a real value. */
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  hint?: ReactNode;
  addLabel?: string;
  custom: {
    name: string;
    label: ReactNode;
    placeholder?: string;
    hint?: ReactNode;
    defaultValue?: string;
    /** Values this user has typed before, offered back as autocomplete. */
    suggestions?: readonly string[];
  };
  onValueChange?: (value: string) => void;
}) {
  // Uncontrolled select + a mirror of its value: the forms that use this clear
  // themselves by remounting (a changing React key), which re-runs this
  // initialiser and re-applies defaultValue in the same pass. A controlled
  // value would need the same remount anyway, and would additionally break
  // `form.reset()`.
  const [value, setValue] = useState(defaultValue);
  const listId = useId();
  const isCustom = value === CUSTOM_CHOICE;
  const suggestions = custom.suggestions ?? [];

  return (
    <>
      <Field label={label} htmlFor={name} hint={hint}>
        <Select
          id={name}
          name={name}
          required={required}
          defaultValue={defaultValue}
          onChange={(e) => {
            setValue(e.target.value);
            onValueChange?.(e.target.value);
          }}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          <option value={CUSTOM_CHOICE}>{addLabel}</option>
        </Select>
      </Field>

      {isCustom ? (
        <Field label={custom.label} htmlFor={custom.name} hint={custom.hint}>
          <Input
            id={custom.name}
            name={custom.name}
            type="text"
            required
            autoFocus
            maxLength={MAX_CUSTOM_LABEL}
            defaultValue={custom.defaultValue}
            placeholder={custom.placeholder}
            list={suggestions.length > 0 ? listId : undefined}
          />
          {suggestions.length > 0 ? (
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
        </Field>
      ) : null}
    </>
  );
}
