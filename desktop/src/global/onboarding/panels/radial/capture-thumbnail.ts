/** Data-URL thumbnail used by vacuum demos (matches capture preview placeholder). */
export function makeCaptureThumbnail(): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="620" height="390" viewBox="0 0 620 390">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#eef5ff"/>
          <stop offset="100%" stop-color="#dbe9fb"/>
        </linearGradient>
      </defs>
      <rect width="620" height="390" rx="26" fill="#f7fbff"/>
      <rect x="0" y="0" width="620" height="56" rx="26" fill="#edf4ff"/>
      <circle cx="34" cy="28" r="8" fill="#f59e0b"/>
      <circle cx="58" cy="28" r="8" fill="#60a5fa"/>
      <circle cx="82" cy="28" r="8" fill="#34d399"/>
      <rect x="122" y="16" width="366" height="24" rx="12" fill="#ffffff"/>
      <rect x="32" y="84" width="556" height="274" rx="22" fill="url(#bg)"/>
      <rect x="56" y="112" width="198" height="154" rx="18" fill="#ffffff"/>
      <rect x="278" y="112" width="286" height="66" rx="18" fill="#ffffff"/>
      <rect x="278" y="198" width="286" height="134" rx="18" fill="#ffffff"/>
      <rect x="78" y="134" width="104" height="12" rx="6" fill="#bfd6fb"/>
      <rect x="78" y="156" width="138" height="10" rx="5" fill="#d8e7fd"/>
      <rect x="78" y="176" width="122" height="10" rx="5" fill="#d8e7fd"/>
      <rect x="78" y="204" width="86" height="38" rx="12" fill="#8eb7ff"/>
      <rect x="300" y="134" width="110" height="12" rx="6" fill="#bfd6fb"/>
      <rect x="300" y="156" width="224" height="10" rx="5" fill="#d8e7fd"/>
      <rect x="300" y="220" width="200" height="12" rx="6" fill="#bfd6fb"/>
      <rect x="300" y="244" width="232" height="10" rx="5" fill="#d8e7fd"/>
      <rect x="300" y="266" width="212" height="10" rx="5" fill="#d8e7fd"/>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
