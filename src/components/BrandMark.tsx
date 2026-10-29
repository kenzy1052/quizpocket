import React from 'react';

export function BrandMark({ className = 'w-9 h-9' }: { className?: string }) {
  return (
    <div className={`relative flex items-center justify-center shrink-0 ${className}`}>
      <svg
        viewBox="0 0 44 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-sm"
        role="img"
        aria-label="QuizPocket"
      >
        <rect
          width="44"
          height="44"
          rx="12"
          fill="#013F32"
          className="transition-colors"
        />
        <circle
          cx="19"
          cy="19"
          r="9"
          stroke="#E7FE25"
          strokeWidth="3.5"
          fill="none"
        />
        <path
          d="M26 26L34 34"
          stroke="#E7FE25"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle
          cx="19"
          cy="19"
          r="3"
          fill="#E7FE25"
        />
      </svg>
    </div>
  );
}
