import type { SVGProps } from 'react';

/**
 * Filled warning triangle with an exclamation mark — used to flag a guest
 * as "Sorunlu Misafir" so housekeeping / reception spot it at a glance.
 * Single-color (uses currentColor); the caller applies amber/red as needed.
 */
export function WarningTriangleIcon({
  className = 'h-4 w-4',
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.866 2.5a1 1 0 0 0-1.732 0L1.293 19.5A1 1 0 0 0 2.16 21h19.682a1 1 0 0 0 .866-1.5L12.866 2.5ZM12 9a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0v-4a1 1 0 0 1 1-1Zm0 9.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"
      />
    </svg>
  );
}
