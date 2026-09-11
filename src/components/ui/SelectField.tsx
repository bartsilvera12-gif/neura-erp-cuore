"use client";

import { Children, isValidElement, useState, type ReactNode } from "react";
import { FancySelect, type FancySelectOption } from "./FancySelect";

/**
 * Adaptador de `<select>` nativo a `FancySelect`.
 *
 * Existe para poder unificar el look de los selectores de todo el ERP sin
 * reescribir 173 formularios: se cambia el tag y el resto de las props queda
 * igual — `name`, `value`, `onChange(e)`, `<option>` como hijos.
 *
 * Por qué hacía falta: el desplegable de un `<select>` nativo lo dibuja el
 * sistema operativo y no se puede estilar por CSS. La única forma de que se vea
 * igual en todas las pantallas es renderizar la lista nosotros.
 *
 * El `onChange` recibe un objeto con la forma de un ChangeEvent (`target.name`,
 * `target.value`) para que los handlers existentes funcionen sin tocarlos.
 */

/** Aplana children a través de arrays y fragments, que es como llegan los `.map()`. */
function recolectarOpciones(children: ReactNode, acc: FancySelectOption[] = []): FancySelectOption[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;

    if (child.type === "option") {
      const props = child.props as { value?: string | number; disabled?: boolean; children?: ReactNode };
      const label = Children.toArray(props.children)
        .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
        .join("")
        .trim();
      acc.push({
        value: props.value == null ? "" : String(props.value),
        label: label || String(props.value ?? ""),
        disabled: props.disabled,
      });
      return;
    }

    // Fragment o wrapper: seguir bajando.
    const props = child.props as { children?: ReactNode };
    if (props?.children) recolectarOpciones(props.children, acc);
  });
  return acc;
}

/**
 * De la className del `<select>` original conservamos sólo lo que posiciona
 * (ancho, grid, márgenes) y descartamos lo que pinta (borde, fondo, padding,
 * foco): eso ahora lo aporta FancySelect. Si dejáramos pasar las clases de
 * pintura, cada selector quedaría con doble borde.
 */
const LAYOUT_PREFIX = /^(w-|min-w-|max-w-|col-|row-|flex|grow|shrink|basis-|self-|justify-|order-|m[trblxy]?-|hidden|block|inline)/;

function soloLayout(className?: string): string {
  if (!className) return "";
  return className
    .split(/\s+/)
    .filter((c) => c && LAYOUT_PREFIX.test(c))
    .join(" ");
}

export type SelectFieldProps = {
  /** Controlado. Si se omite y hay `defaultValue`, el componente se maneja solo. */
  value?: string | number | readonly string[] | undefined;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  /** No controlado: usado por los formularios que leen con FormData al enviar. */
  defaultValue?: string | number | readonly string[];
  children: ReactNode;
  name?: string;
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  placeholder?: string;
  size?: "sm" | "md";
};

export default function SelectField({
  value,
  onChange,
  defaultValue,
  children,
  name,
  id,
  className,
  style,
  disabled,
  required,
  "aria-label": ariaLabel,
  placeholder,
  size = "md",
}: SelectFieldProps) {
  const options = recolectarOpciones(children);

  const controlado = value !== undefined;
  const [interno, setInterno] = useState(defaultValue == null ? "" : String(defaultValue));
  const actual = controlado ? (value == null ? "" : String(value)) : interno;

  const campo = (
    <FancySelect
      options={options}
      value={actual}
      disabled={disabled}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      size={size}
      className={soloLayout(className) || "w-full"}
      onChange={(v) => {
        if (!controlado) setInterno(v);
        // Forma mínima de ChangeEvent: los handlers del ERP leen target.name y
        // target.value, y algunos llaman preventDefault.
        const target = { name: name ?? "", value: v, id: id ?? "" };
        onChange?.({
          target,
          currentTarget: target,
          preventDefault() {},
          stopPropagation() {},
        } as unknown as React.ChangeEvent<HTMLSelectElement>);
      }}
    />
  );

  return (
    <>
      {style ? <div style={style}>{campo}</div> : campo}
      {/* FancySelect es un <button>, no un control de formulario: este input
          espejo mantiene el valor accesible para FormData y para `required`. */}
      {name ? <input type="hidden" name={name} value={actual} required={required} /> : null}
    </>
  );
}
