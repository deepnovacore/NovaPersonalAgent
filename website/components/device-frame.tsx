import type { CSSProperties, ReactNode } from 'react';

// Pure-CSS device bodies. The screen box takes the recording's own aspect
// ratio, so a phone clip is never cropped into a landscape box.
export function DeviceFrame({
  kind,
  width,
  height,
  children,
  className = '',
}: {
  kind: 'mac' | 'phone';
  width: number;
  height: number;
  children: ReactNode;
  className?: string;
}) {
  const style = { '--ar': `${width} / ${height}` } as CSSProperties;
  return (
    <div className={`device device-${kind} ${className}`} style={style}>
      <div className="device-screen">{children}</div>
    </div>
  );
}
