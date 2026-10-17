import type { ReactNode, SVGProps } from 'react';

function Svg(props: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export function IconHand() {
  return (
    <Svg>
      <path d="M8.2 11.2V6.4a1.15 1.15 0 0 1 2.3 0V11" />
      <path d="M10.5 10.2V5.1a1.15 1.15 0 0 1 2.3 0v6" />
      <path d="M12.8 10.5V6.6a1.15 1.15 0 0 1 2.3 0V12" />
      <path d="M15.1 11.4V8.3a1.15 1.15 0 0 1 2.2.2v4.8c0 2.8-1.7 4.9-4.4 4.9-2.4 0-3.9-1.1-4.8-2.9L6.2 12.4a1.2 1.2 0 0 1 1.9-.9l.3.3" />
    </Svg>
  );
}
export function IconSelect() {
  return (
    <Svg>
      <path d="M6 4.5 17.5 11l-5.2 1.3-1.2 5.4L6 4.5Z" />
    </Svg>
  );
}
export function IconLine() {
  return (
    <Svg>
      <path d="M5 17.5 17.5 6" />
      <circle cx="5" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function IconRect() {
  return (
    <Svg>
      <rect x="4.5" y="6.5" width="15" height="11" rx="0.5" />
    </Svg>
  );
}
export function IconCircle() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="6.5" />
    </Svg>
  );
}
export function IconPush() {
  return (
    <Svg>
      <path d="M5 15.5h8.5V9.2H5z" />
      <path d="M14 8.2 18.5 5.5 18.5 12 14 9.4" />
    </Svg>
  );
}
export function IconMove() {
  return (
    <Svg>
      <path d="M12 3.5v17M3.5 12h17" />
      <path d="m12 3.5 2.2 2.4M12 3.5 9.8 5.9M12 20.5l2.2-2.4M12 20.5 9.8 18.1M3.5 12l2.4-2.2M3.5 12l2.4 2.2M20.5 12l-2.4-2.2M20.5 12l-2.4 2.2" />
    </Svg>
  );
}
export function IconRotate() {
  return (
    <Svg>
      <path d="M18.5 12a6.5 6.5 0 1 1-2-4.7" />
      <path d="M16.2 3.8v4.2H12" />
    </Svg>
  );
}
export function IconScale() {
  return (
    <Svg>
      <path d="M8 16 16 8" />
      <path d="M9 5.5H5.5V9M15 18.5h3.5V15" />
      <path d="M5.5 5.5 9 9M18.5 18.5 15 15" />
    </Svg>
  );
}
export function IconPaint() {
  return (
    <Svg>
      <path d="M8 14.5c0 2.4 1.6 4 3.4 4 1.2 0 1.8-.7 1.8-1.5 0-1.4-2-1.6-2-3.2 0-.8.7-1.8 2.2-1.8H16.5V5.5H7.2v6.2" />
    </Svg>
  );
}
export function IconErase() {
  return (
    <Svg>
      <path d="m14.8 5.2 4 4-7.6 7.6H8.2L4.8 13.4l7.4-8.2h2.6Z" />
      <path d="M5 19h9" />
    </Svg>
  );
}
export function IconUndo() {
  return (
    <Svg>
      <path d="M8 8H4.5V4.5" />
      <path d="M5 9.2A7 7 0 1 1 6.2 16" />
    </Svg>
  );
}
export function IconRedo() {
  return (
    <Svg>
      <path d="M16 8h3.5V4.5" />
      <path d="M19 9.2A7 7 0 1 0 17.8 16" />
    </Svg>
  );
}
