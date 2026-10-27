import { useId } from 'react';

export function Star({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M32 5c4.2 15.5 11.5 22.8 27 27-15.5 4.2-22.8 11.5-27 27C27.8 43.5 20.5 36.2 5 32 20.5 27.8 27.8 20.5 32 5Z"
        fill="currentColor"
      />
      <path
        d="m32 18 4.1 9.9L46 32l-9.9 4.1L32 46l-4.1-9.9L18 32l9.9-4.1L32 18Z"
        fill="#fff"
        opacity=".45"
      />
    </svg>
  );
}

export function CloudFriend({
  sleepy = false,
  className = '',
}: {
  sleepy?: boolean;
  className?: string;
}) {
  const id = useId().replaceAll(':', '');
  return (
    <svg className={className} viewBox="0 0 244 210" fill="none" aria-hidden="true">
      <defs>
        <linearGradient
          id={`cloud-${id}`}
          x1="122"
          y1="36"
          x2="122"
          y2="167"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--post-cloud-top, #fff)" />
          <stop offset="1" stopColor="var(--post-cloud-bottom, #edf6fb)" />
        </linearGradient>
      </defs>
      <ellipse
        cx="123"
        cy="187"
        rx="70"
        ry="9"
        fill="var(--post-cloud-shadow, #82b2c7)"
        opacity=".16"
      />
      <path
        d="M62 154c-29 0-46-15-46-38 0-20 13-35 33-39 2-29 22-47 47-47 18 0 33 9 41 23 8-6 17-9 27-9 25 0 43 17 46 40 18 5 29 19 29 36 0 24-17 39-44 39H62Z"
        fill="var(--post-cloud-underlay, #b5d1e1)"
        opacity=".38"
        transform="translate(0 7)"
      />
      <path
        data-cloud-grip=""
        d="M62 154c-29 0-46-15-46-38 0-20 13-35 33-39 2-29 22-47 47-47 18 0 33 9 41 23 8-6 17-9 27-9 25 0 43 17 46 40 18 5 29 19 29 36 0 24-17 39-44 39H62Z"
        fill={`url(#cloud-${id})`}
        stroke="var(--post-cloud-outline, #d1e5ef)"
        strokeWidth="2"
      />
      <g className="post-new-year-scarf" pointerEvents="none">
        <path
          d="M73 139c25 10 62 10 90-1"
          stroke="var(--post-satchel, #df9f87)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <path d="m98 146-4 25 13-4 7-22" fill="var(--post-satchel, #df9f87)" />
        <path d="m97 161 13-3" stroke="var(--post-scarf-trim, #d8b46a)" strokeWidth="2" />
      </g>
      <path d="M65 77c8-21 21-29 35-29" stroke="#fff" strokeWidth="7" strokeLinecap="round" />
      <ellipse
        cx="83"
        cy="121"
        rx="12"
        ry="7"
        fill="var(--post-cloud-blush, #f3b9ae)"
        opacity=".65"
      />
      <ellipse
        cx="159"
        cy="121"
        rx="12"
        ry="7"
        fill="var(--post-cloud-blush, #f3b9ae)"
        opacity=".65"
      />
      {sleepy ? (
        <>
          <path
            d="m91 104 8 3 8-3M139 104l8 3 8-3"
            stroke="var(--post-cloud-face, #455a69)"
            strokeWidth="3.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <ellipse cx="99" cy="107" rx="3.8" ry="5.5" fill="var(--post-cloud-face, #455a69)" />
          <ellipse cx="147" cy="107" rx="3.8" ry="5.5" fill="var(--post-cloud-face, #455a69)" />
          <circle cx="100" cy="105" r="1.1" fill="#fff" />
          <circle cx="148" cy="105" r="1.1" fill="#fff" />
        </>
      )}
      <path
        d="M116 119c4 5 10 5 14 0"
        stroke="var(--post-cloud-face, #455a69)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="m173 129-10 41"
        stroke="var(--post-satchel-strap, #889ca9)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <rect
        data-cloud-grip=""
        x="147"
        y="151"
        width="48"
        height="35"
        rx="8"
        transform="rotate(8 147 151)"
        fill="var(--post-satchel, #df9f87)"
      />
      <path
        d="m151 156 17 15 20-10"
        stroke="var(--post-satchel-fold, #f7d5c5)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path d="m73 151-5 12m61-9 4 10" stroke="#d0e3ee" strokeWidth="7" strokeLinecap="round" />
      <path
        d="M48 22c-2-7 4-12 10-9 4-6 12-3 12 4 0 8-13 16-13 16s-7-4-9-11Z"
        fill="var(--post-star, #f0be76)"
        transform="rotate(-15 57 22)"
      />
    </svg>
  );
}

export function PaperPlane({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 80" fill="none" aria-hidden="true">
      <path
        d="m9 35 81-23-26 56-19-20L9 35Z"
        fill="var(--post-plane-fill, #fffdf6)"
        stroke="var(--post-plane-line, #a7c3d1)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m90 12-45 36-5 22 14-13"
        stroke="var(--post-plane-line, #a7c3d1)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m45 48 19 20L90 12 45 48Z" fill="var(--post-plane-fold, #dfedf3)" />
      <path d="m45 48-5 22 14-13" fill="var(--post-plane-shade, #bfd6e1)" />
    </svg>
  );
}
