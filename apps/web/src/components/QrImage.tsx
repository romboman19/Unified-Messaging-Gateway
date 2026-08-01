import qrcode from 'qrcode-generator';

/**
 * Tiny QR renderer. Hand-rolled to avoid pulling in a heavier image lib.
 * Uses `qrcode-generator` (Type 0 = auto-detect minimum version, error
 * correction L is enough for the URIs we encode — typically < 256 chars).
 */
export function QrImage({ uri, size = 256 }: { uri: string; size?: number }) {
  const qr = qrcode(0, 'L');
  qr.addData(uri);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const cellSize = Math.floor(size / (moduleCount + 4));
  const realSize = cellSize * (moduleCount + 4);
  const cells: JSX.Element[] = [];
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (qr.isDark(r, c)) {
        cells.push(
          <rect
            key={`${r}-${c}`}
            x={2 + c * cellSize}
            y={2 + r * cellSize}
            width={cellSize}
            height={cellSize}
            fill="black"
          />,
        );
      }
    }
  }
  return (
    <svg
      width={realSize}
      height={realSize}
      viewBox={`0 0 ${realSize} ${realSize}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="QR-код для прив'язки пристрою"
      className="rounded border bg-white p-2"
    >
      <rect width={realSize} height={realSize} fill="white" />
      {cells}
    </svg>
  );
}