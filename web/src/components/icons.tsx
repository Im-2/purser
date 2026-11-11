import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, p: SVGProps<SVGSVGElement>) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

export const IconBolt = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
);
export const IconCheck = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);
export const IconX = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconClock = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconAlert = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5v.01" /></svg>
);
export const IconPlay = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor" stroke="none" /></svg>
);
export const IconReset = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M4 12a8 8 0 1 0 2.6-5.9" /><path d="M4 4v4.5h4.5" /></svg>
);
export const IconInfo = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
);
export const IconShield = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /></svg>
);
export const IconSnow = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M12 2v20M3.5 7l17 10M20.5 7l-17 10" /></svg>
);
export const IconSignOut = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" /></svg>
);
export const IconChevronRight = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="m9 5 7 7-7 7" /></svg>
);
export const IconFlask = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><path d="M9 3h6M10 3v6.2L4.6 18.4A2 2 0 0 0 6.3 21.5h11.4a2 2 0 0 0 1.7-3.1L14 9.2V3" /><path d="M7.5 15h9" /></svg>
);
export const IconUser = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5" /></svg>
);
export const IconRobot = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4.5M9 13v1.5M15 13v1.5" /><circle cx="12" cy="3.5" r="1" /></svg>
);
