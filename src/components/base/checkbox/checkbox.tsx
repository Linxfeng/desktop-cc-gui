"use client";

import { useId } from "react";
import type { ReactNode, Ref } from "react";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import type { CheckboxProps as AriaCheckboxProps } from "react-aria-components";
import { cx } from "@/utils/cx";
import { CheckboxGlyph } from "./checkbox-glyph";
import { checkboxSizes } from "./checkbox-sizes";
import type { CheckboxSize } from "./checkbox-sizes";

/**
 * Figma source: Board UI → Checkbox (node 3699:2557 family; used in
 * dashboard 1 table, nodes 3731:3258 etc.).
 *
 * radius/sm (4px). Two sizes:
 *   md  16×16, label Body 1/Medium (14)
 *   sm  14×14, label Body 2/Medium (13)
 *
 * States (per Figma):
 *   default        bg background/primary/default, 1px border/checkbox/default,
 *                  shadow/xs
 *   hover          border darkens to neutral/400
 *   checked /      Button/Primary gradient (blue/500 → blue/600) with the
 *   indeterminate  checkbox inner highlight (see --shadow-checkbox-selected),
 *                  white 2px rounded stroke glyph; on hover the gradient
 *                  lightens to blue/400 → blue/500
 *
 * Built on react-aria Checkbox: keyboard toggling, aria-checked="mixed" for
 * indeterminate, label association when `children` is passed.
 *
 * `hint` renders a secondary line under the label inside the same <label>, so
 * the whole block (full row width) is the click target; it is wired up as the
 * input's description, keeping the accessible name to the label alone.
 */

export interface CheckboxProps extends Omit<AriaCheckboxProps, "children"> {
  children?: ReactNode;
  hint?: ReactNode;
  size?: CheckboxSize;
  ref?: Ref<HTMLLabelElement>;
}

export function Checkbox({ className, children, hint, size = "md", ref, ...props }: CheckboxProps) {
  const s = checkboxSizes[size];
  const labelId = useId();
  const hintId = useId();
  const hasLabel = children !== undefined && children !== null;
  const hasHint = hint !== undefined && hint !== null;
  const describedProps = hasHint
    ? { "aria-labelledby": hasLabel ? labelId : undefined, "aria-describedby": hintId }
    : {};

  return (
    <AriaCheckbox
      ref={ref}
      {...describedProps}
      {...props}
      className={(state) =>
        cx(
          "group select-none",
          // Grid keeps the box centered on the label line while the hint sits
          // under the label column.
          hasHint
            ? cx("grid w-full grid-cols-[auto_minmax(0,1fr)] items-center", s.gap, "gap-y-0.5")
            : cx("inline-flex items-center", s.gap),
          state.isDisabled ? "cursor-not-allowed" : "cursor-pointer",
          typeof className === "function" ? className(state) : className,
        )
      }
    >
      {(state) => (
        <>
          <CheckboxGlyph state={state} size={size} />
          {hasLabel && (
            <span id={labelId} className={cx(s.label, "text-text-primary")}>
              {children}
            </span>
          )}
          {hasHint && (
            <span id={hintId} className="col-start-2 text-caption-1-regular text-text-tertiary">
              {hint}
            </span>
          )}
        </>
      )}
    </AriaCheckbox>
  );
}
