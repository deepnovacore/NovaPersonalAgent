# Release verification

Build with the platform package command, then run `npm run verify:release --workspace @nova-audio-agent/desktop -- --unsigned` for a local unsigned candidate. Use `--artifact /absolute/path/to/installer` to exercise installation, or `--app /absolute/path/to/unpacked/app` for an existing application.

The verifier checks ASAR unpack placement, native resource presence, platform signature verification (unless `--unsigned`), and a real installed application/backend authenticated handshake with an isolated home and local provider. It does not publish anything. Signed macOS acceptance requires both codesign and Gatekeeper to succeed. macOS notarization remains in the build/signing path.
