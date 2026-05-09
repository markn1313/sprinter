import { CSSProperties } from "react";

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

// Black Sprinter van silhouette — used throughout the app for visual consistency
export default function VanIcon({ size = 22, className, style }: Props) {
  const w = size;
  const h = Math.round((size * 36) / 64);
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 64 36"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M4 24 L4 12 Q4 6 10 6 L40 6 Q46 6 50 10 L60 16 L60 24 Q60 26 58 26 L52 26 A4 4 0 1 0 44 26 L20 26 A4 4 0 1 0 12 26 L6 26 Q4 26 4 24 Z"
        fill="#0a0a0a"
        stroke="#fff"
        strokeWidth="1.2"
      />
      <path d="M40 8 L48 10 L56 16 L40 16 Z" fill="#3b3b3b" />
      <rect x="14" y="10" width="22" height="6" rx="1" fill="#3b3b3b" />
      <circle cx="16" cy="26" r="3.5" fill="#1a1a1a" stroke="#fff" strokeWidth="0.8" />
      <circle cx="48" cy="26" r="3.5" fill="#1a1a1a" stroke="#fff" strokeWidth="0.8" />
    </svg>
  );
}
