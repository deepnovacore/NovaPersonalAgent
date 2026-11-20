// Small platform marks for the download buttons. Apple follows the Simple
// Icons glyph; Windows, Linux and Android are drawn simply at the same weight.
type P = { size?: number };
const box = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  'aria-hidden': true as const,
  focusable: 'false' as const,
});

export function AppleIcon({ size = 18 }: P) {
  return (
    <svg {...box(size)} fill="currentColor">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

export function WindowsIcon({ size = 18 }: P) {
  return (
    <svg {...box(size)} fill="currentColor">
      <path d="M2 2h9.5v9.5H2zM12.5 2H22v9.5h-9.5zM2 12.5h9.5V22H2zM12.5 12.5H22V22h-9.5z" />
    </svg>
  );
}

export function LinuxIcon({ size = 18 }: P) {
  // A penguin: head and body, belly cut out, two feet.
  return (
    <svg {...box(size)} fill="currentColor">
      <path
        fillRule="evenodd"
        d="M12 1.5c-2.9 0-4.6 2.3-4.6 5.3 0 1.5-.6 2.6-1.6 4.2C4.6 13 3.8 15 3.8 17c0 3 2.8 5.5 8.2 5.5s8.2-2.5 8.2-5.5c0-2-.8-4-2-6-1-1.6-1.6-2.7-1.6-4.2 0-3-1.7-5.3-4.6-5.3zM12 9.4c-2.5 0-4.4 3.1-4.4 6.6 0 2.6 1.8 4.2 4.4 4.2s4.4-1.6 4.4-4.2c0-3.5-1.9-6.6-4.4-6.6zM10.3 5.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zm3.4 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z"
      />
      <path d="M10.4 7.8h3.2L12 9.6z" />
    </svg>
  );
}

export function AndroidIcon({ size = 18 }: P) {
  return (
    <svg {...box(size)} fill="currentColor">
      <path
        fillRule="evenodd"
        d="M2.5 18.5a9.5 9.5 0 0 1 19 0zM8 13.6a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3zm8 0a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z"
      />
      <path d="M6.3 6.4l1.9 3.1-.9.5-1.9-3.1zM17.7 6.4l-1.9 3.1.9.5 1.9-3.1z" />
    </svg>
  );
}
