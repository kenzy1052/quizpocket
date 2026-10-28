import React from 'react';

export function BrandMark({ className = 'w-9 h-9' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="QuizPocket"
    >
      <path
        d="M20.7 7.5a12.2 12.2 0 1 0 0 24.4 12.2 12.2 0 0 0 0-24.4Zm0 5a7.2 7.2 0 1 1 0 14.4 7.2 7.2 0 0 1 0-14.4Z"
        fill="#15B8A6"
      />
      <path
        d="m28.8 27.2 6.1 6.1"
        stroke="#15B8A6"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
      <path
        d="M23.1 19.7c0-4 2.8-6.8 6.4-6.8 3.8 0 6.2 3 6.2 7.2v5.2c0 4.2-2.2 6.8-6 6.8-2.5 0-4.5-1.3-5.6-3.4"
        stroke="#202A39"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
