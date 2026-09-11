// Retired: legacy schemas no longer match production. Keep the old command fail-closed.
console.error('This legacy live smoke is retired. Use scripts/live/run.mjs --list; replacement: text-tools and coordinator. Current-schema voice routing remains uncovered.')
process.exitCode = 2
