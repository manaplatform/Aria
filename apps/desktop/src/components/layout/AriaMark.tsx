import { useId } from 'react';

export function AriaMark({ small = false }: { small?: boolean }) {
  const gradient = useId();
  return (
    <svg className={small ? 'aria-mark small' : 'aria-mark'} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="1" y2="0">
          <stop stopColor="#6476ed" />
          <stop offset=".5" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#7449eb" />
        </linearGradient>
      </defs>
      <path
        d="M16 6c2-4 6-4 8 0l13 25c3 6-4 10-8 5L20 23l-9 13c-4 5-11 1-8-5Z"
        fill={`url(#${gradient})`}
      />
      <path d="m20 10 9 26c-3-1-7-7-9-13l-4-9Z" fill="#c4b5fd" opacity=".65" />
    </svg>
  );
}
