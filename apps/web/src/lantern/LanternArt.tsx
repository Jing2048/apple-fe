import { useId } from 'react';
import './art.css';

export type LanternColor = 'red' | 'apricot' | 'ivory';
export type LanternPattern = 'blossom' | 'window' | 'ripple';

export interface LanternArtProps {
  open: number;
  color: LanternColor;
  pattern: LanternPattern;
  lit?: boolean;
  flying?: boolean;
  className?: string;
}

/* Original paper colors. The surrounding experience owns all gestures and movement. */
const papers = {
  red: { edge: '#A7202B', paper: '#CE5145', center: '#E98262', motif: '#FFF0D3' },
  apricot: { edge: '#C67B4D', paper: '#EBB47F', center: '#F6D4A7', motif: '#8D3B32' },
  ivory: { edge: '#D2BB8E', paper: '#F6E7C7', center: '#FFF9E9', motif: '#A62B33' },
} as const;

function Blossom({ ink }: { ink: string }) {
  return (
    <g fill="none" stroke={ink} strokeLinecap="round" strokeLinejoin="round">
      <path d="M-32 32C-12 19-22-2-3-29M-16 14C-5 10 3 10 12 14" strokeWidth="1.6" />
      <g transform="translate(1 -12)">
        {[0, 72, 144, 216, 288].map((rotation) => (
          <ellipse
            key={rotation}
            cx="0"
            cy="-10"
            rx="5.3"
            ry="8.2"
            transform={`rotate(${rotation})`}
            fill={ink}
            fillOpacity=".8"
            stroke="none"
          />
        ))}
        <circle r="3.2" fill="#D8B46A" stroke="none" />
      </g>
      <g transform="translate(21 20) scale(.63)">
        {[0, 72, 144, 216, 288].map((rotation) => (
          <ellipse
            key={rotation}
            cx="0"
            cy="-10"
            rx="5.3"
            ry="8.2"
            transform={`rotate(${rotation})`}
            fill={ink}
            fillOpacity=".8"
            stroke="none"
          />
        ))}
        <circle r="3.2" fill="#D8B46A" stroke="none" />
      </g>
      <path
        d="M-22 20c-6-1-9-6-7-11 6 0 9 4 7 11ZM-15 7c3-6 7-8 12-6-1 6-6 9-12 6Z"
        fill={ink}
        fillOpacity=".55"
        stroke="none"
      />
    </g>
  );
}

function WindowPattern({ ink }: { ink: string }) {
  return (
    <g fill="none" stroke={ink} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path
        d="m0-36 13 11 17 2 2 17L43 7 31 19l-2 16-17 2L0 48l-12-11-17-2-2-16L-43 7l11-13 2-17 17-2Z"
        transform="translate(0 -5) scale(.84)"
      />
      {[0, 90, 180, 270].map((rotation) => (
        <path
          key={rotation}
          d="M0-4C-8-8-15-15-16-25-6-24 1-17 0-4Z"
          transform={`rotate(${rotation})`}
          fill={ink}
          fillOpacity=".62"
          stroke="none"
        />
      ))}
      <path d="m0-7 7 7-7 7-7-7Z" fill="#D8B46A" stroke="none" />
      <circle r="1.8" fill={ink} stroke="none" />
    </g>
  );
}

function Ripples({ ink }: { ink: string }) {
  return (
    <g fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round">
      <circle cx="18" cy="-21" r="7" fill="#D8B46A" fillOpacity=".85" stroke="none" />
      <path d="M-34-8c12-11 23-11 35 0s23 11 34 0M-39 7c14-12 27-12 40 0s26 12 39 0M-31 22c10-9 20-9 30 0s20 9 30 0" />
      <path d="M-16 35c6-4 11-4 17 0s11 4 16 0" strokeWidth="1.2" opacity=".6" />
    </g>
  );
}

/**
 * Fixed 280×340 canvas. HTML grip anchor: x=140, y=294 (50%, 86.47%).
 * Paper expands internally from y=78..122 to y=78..250. No SVG element is a hit target.
 */
export function LanternArt({
  open,
  color,
  pattern,
  lit,
  flying = false,
  className = '',
}: LanternArtProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const progress = Number.isFinite(open) ? Math.min(1, Math.max(0, open)) : 0;
  const palette = papers[color] ?? papers.red;
  const top = 78;
  const height = 44 + progress * 128;
  const bottom = top + height;
  const left = 140 - (76 + progress * 17);
  const right = 280 - left;
  const middle = top + height * 0.5;
  const body = `M89 ${top}C${left + 9} ${top + height * 0.025} ${left} ${top + height * 0.25} ${left} ${middle}C${left} ${top + height * 0.84} 86 ${bottom} 140 ${bottom}C194 ${bottom} ${right} ${top + height * 0.84} ${right} ${middle}C${right} ${top + height * 0.25} ${right - 9} ${top + height * 0.025} 191 ${top}Q140 ${top - 7} 89 ${top}Z`;
  const illuminated = lit ?? flying;
  const motifOpacity = Math.min(1, Math.max(0, (progress - 0.14) / 0.7));
  return (
    <svg
      className={`lantern-art ${className}`}
      viewBox="0 0 280 340"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-lit={illuminated}
      data-flying={flying}
    >
      <defs>
        <linearGradient
          id={`paper-${id}`}
          x1={left}
          x2={right}
          y1={middle}
          y2={middle}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={palette.edge} />
          <stop offset=".23" stopColor={palette.paper} />
          <stop offset=".5" stopColor={palette.center} />
          <stop offset=".77" stopColor={palette.paper} />
          <stop offset="1" stopColor={palette.edge} />
        </linearGradient>
        <linearGradient
          id={`shade-${id}`}
          x1="140"
          x2="140"
          y1={top}
          y2={bottom}
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#743C22" stopOpacity=".1" />
          <stop offset=".3" stopColor="#743C22" stopOpacity="0" />
          <stop offset="1" stopColor="#743C22" stopOpacity=".1" />
        </linearGradient>
        <radialGradient id={`light-${id}`} cx=".5" cy=".47" r=".58">
          <stop stopColor="#FFF2B7" stopOpacity=".72" />
          <stop offset=".58" stopColor="#F6C97E" stopOpacity=".2" />
          <stop offset="1" stopColor="#F6C97E" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`shape-${id}`}>
          <path d={body} />
        </clipPath>
      </defs>

      <ellipse
        className="lantern-art__ground-shadow"
        cx="140"
        cy="322"
        rx="61"
        ry="7"
        fill="#93704C"
        opacity=".09"
      />
      <path d="M140 32c12 7 12 19 0 27" stroke="#B82025" strokeWidth="2" strokeLinecap="round" />
      <path d="m140 55 4 5-4 5-4-5Z" fill="#B82025" />
      <path d="M140 64v12" stroke="#AC7450" strokeWidth="1.4" />
      <path d={body} fill={`url(#paper-${id})`} stroke={palette.edge} strokeWidth="1" />
      <g clipPath={`url(#shape-${id})`}>
        {Array.from({ length: 8 }, (_, index) => (
          <rect
            key={index}
            x={left - 1}
            y={top + (height * index) / 8}
            width={right - left + 2}
            height={height / 8}
            fill={index % 2 === 0 ? '#FFF7E7' : '#743C22'}
            opacity={index % 2 === 0 ? '.055' : '.025'}
          />
        ))}
        <path d={body} fill={`url(#shade-${id})`} />
        <path className="lantern-art__warmth" d={body} fill={`url(#light-${id})`} />
        {[1, 2, 3, 4, 5, 6, 7].map((index) => {
          const y = top + (height * index) / 8;
          return (
            <path
              key={index}
              d={`M${left - 2} ${y}Q140 ${y + progress * 2.4} ${right + 2} ${y}`}
              stroke="#FFF6DF"
              strokeWidth=".9"
              opacity={0.2 + (1 - progress) * 0.18}
            />
          );
        })}
        <path
          d={`M109 ${top}C88 ${top + height * 0.32} 88 ${top + height * 0.73} 111 ${bottom}M171 ${top}C192 ${top + height * 0.32} 192 ${top + height * 0.73} 169 ${bottom}M140 ${top}V${bottom}`}
          stroke="#FFF8E4"
          strokeWidth=".8"
          opacity=".22"
        />
        <g
          className="lantern-art__motif"
          transform={`translate(140 ${top + height * 0.52})`}
          opacity={motifOpacity}
        >
          {pattern === 'blossom' ? (
            <Blossom ink={palette.motif} />
          ) : pattern === 'window' ? (
            <WindowPattern ink={palette.motif} />
          ) : (
            <Ripples ink={palette.motif} />
          )}
        </g>
      </g>

      <path d="M89 74q51-13 102 0v10q-51 10-102 0Z" fill="#AB2830" />
      <path d="M93 75q47-10 94 0" stroke="#D8B46A" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d={`M91 ${bottom - 6}Q140 ${bottom + 5} 189 ${bottom - 6}V${bottom + 3}Q140 ${bottom + 14} 91 ${bottom + 3}Z`}
        fill="#AB2830"
      />
      <path
        d={`M94 ${bottom + 1}Q140 ${bottom + 10} 186 ${bottom + 1}`}
        stroke="#D8B46A"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path d={`M140 ${bottom + 11}V278`} stroke="#BB9260" strokeWidth="1.3" />
      <path d="m140 276 4 5-4 5-4-5Z" fill="#D8B46A" />
      <g stroke="#C48E54" strokeWidth="1" strokeLinecap="round">
        <path d={`M182 ${bottom + 6}v23m3-22v24m3-23v20`} />
      </g>
    </svg>
  );
}
