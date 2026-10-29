import React from 'react';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  hoverEffect?: boolean;
  padding?: string;
}

export function GlassCard({
  children,
  className = '',
  hoverEffect = false,
  padding = 'p-6',
  ...rest
}: GlassCardProps) {
  return (
    <div
      {...rest}
      className={`relative rounded-3xl bg-white/80 dark:bg-[#1A1D1B]/80 backdrop-blur-xl border border-neutral-200/80 dark:border-white/10 shadow-[0_8px_30px_rgb(1,63,50,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.4)] ${padding} ${
        hoverEffect
          ? 'transition-all duration-300 hover:shadow-[0_16px_40px_rgb(1,63,50,0.08)] dark:hover:shadow-[0_16px_40px_rgb(0,0,0,0.6)] hover:-translate-y-0.5 hover:border-[#013F32]/25 dark:hover:border-[#E7FE25]/30'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
