import { InputHTMLAttributes } from "react";

export function Input({
  className = "",
  "aria-invalid": ariaInvalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const invalid = ariaInvalid === true || ariaInvalid === "true";
  return (
    <input
      aria-invalid={ariaInvalid}
      className={`mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 ${
        invalid
          ? "border-red-400 focus:border-red-500 focus:ring-red-500"
          : "border-gray-300 focus:border-black focus:ring-black"
      } ${className}`}
      {...props}
    />
  );
}
