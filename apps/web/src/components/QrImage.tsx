import qrcode from 'qrcode-generator';

/** Quiet zone required by the QR spec, in modules. Phone scanners rely on
 *  it to find the symbol; anything less and pairing fails intermittently. */
const QUIET_ZONE = 4;

/**
 * Tiny QR renderer. Hand-rolled to avoid pulling in a heavier image lib.
 * Uses `qrcode-generator` (Type 0 = auto-detect minimum version, error
 * correction M — the link URIs run ~150 chars and get scanned off a screen
 * at an angle, so the extra redundancy is worth the denser symbol).
 */
export function QrImage({ uri, size = 256 }: { uri: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const totalModules = moduleCount + QUIET_ZONE * 2;
  const cellSize = Math.max(1, Math.floor(size / totalModules));
  const realSize = cellSize * totalModules;
  const cells: JSX.Element[] = [];
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (qr.isDark(r, c)) {
        cells.push(
          <rect
            key={`${r}-${c}`}
            x={(QUIET_ZONE + c) * cellSize}
            y={(QUIET_ZONE + r) * cellSize}
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