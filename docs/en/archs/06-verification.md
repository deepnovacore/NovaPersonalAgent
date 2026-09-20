# Local development

Use Node.js 22.13 or later. From the repository root:

```sh
npm ci
npm run check
npm run build
npm test
```

Run builds one at a time because they share generated runtime output. For an executor change, also exercise its input validation, cancellation, timeout and result handling. Features that use microphones, cameras or external services need a check in that environment with your own devices and credentials.
